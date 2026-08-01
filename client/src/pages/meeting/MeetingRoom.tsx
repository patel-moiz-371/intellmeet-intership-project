import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { io, type Socket } from 'socket.io-client'
import {
  AlertCircle,
  MessageSquare,
  Mic,
  MicOff,
  PhoneOff,
  Send,
  Users,
  Video,
  VideoOff,
  X,
} from 'lucide-react'

import { SOCKET_URL } from '@/config/constants'
import { useAuthStore } from '@/store/authStore'

interface Message {
  id: number
  message: string
  senderName: string
  timestamp: string
}

interface Participant {
  socketId: string
  name: string
  isHost: boolean
}

interface RemoteStreamItem {
  socketId: string
  stream: MediaStream
}

interface MeetingRoomState {
  meetingTitle?: string
  micOn?: boolean
  cameraOn?: boolean
  isHost?: boolean
}

interface OfferPayload {
  fromSocketId: string
  offer: RTCSessionDescriptionInit
}

interface AnswerPayload {
  fromSocketId: string
  answer: RTCSessionDescriptionInit
}

interface IceCandidatePayload {
  fromSocketId: string
  candidate: RTCIceCandidateInit
}

interface ParticipantLeftPayload {
  socketId: string
}

interface RemoteVideoProps {
  stream: MediaStream
}

const requestMeetingMedia = async (): Promise<MediaStream> => {
  const audioSettings: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  }

  // First try camera + microphone.
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        facingMode: 'user',
      },
      audio: audioSettings,
    })
  } catch (error) {
    const mediaError = error as DOMException

    // Do not ignore an actual permission rejection.
    if (mediaError.name === 'NotAllowedError') {
      throw mediaError
    }

    console.warn(
      'Camera unavailable. Trying microphone only:',
      mediaError,
    )
  }

  // If there is no camera, try microphone only.
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: false,
      audio: audioSettings,
    })
  } catch (error) {
    const mediaError = error as DOMException

    if (mediaError.name === 'NotAllowedError') {
      throw mediaError
    }

    console.warn(
      'No usable camera or microphone. Joining without media:',
      mediaError,
    )

    // Allows participants, chat and signaling to work without devices.
    return new MediaStream()
  }
}

const ICE_CONFIGURATION: RTCConfiguration = {
  iceServers: [
    {
      urls: 'stun:stun.l.google.com:19302',
    },
    {
      urls: 'stun:stun1.l.google.com:19302',
    },
  ],
}

const RemoteVideo = ({ stream }: RemoteVideoProps) => {
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const video = videoRef.current

    if (!video) {
      return
    }

    video.srcObject = stream

    void video.play().catch(error => {
      console.warn('Remote video autoplay was blocked:', error)
    })

    return () => {
      video.srcObject = null
    }
  }, [stream])

  return (
    <video
      ref={videoRef}
      autoPlay
      playsInline
      onClick={event => {
        void event.currentTarget.play()
      }}
      className="h-full w-full object-cover"
    />
  )
}

const MeetingRoom = () => {
  const { meetingCode } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const { user } = useAuthStore()

  const roomState =
    (location.state as MeetingRoomState | null) || {}

  const meetingTitle = roomState.meetingTitle || 'Meeting'
  const isHost = roomState.isHost || false
  const initialMicOn = roomState.micOn ?? true
  const initialCameraOn = roomState.cameraOn ?? true

  const localVideoRef = useRef<HTMLVideoElement>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const socketRef = useRef<Socket | null>(null)

  const peerConnectionsRef = useRef<
    Map<string, RTCPeerConnection>
  >(new Map())

  const pendingCandidatesRef = useRef<
    Map<string, RTCIceCandidateInit[]>
  >(new Map())

  const [micOn, setMicOn] = useState(initialMicOn)
  const [cameraOn, setCameraOn] = useState(initialCameraOn)

  const [micAvailable, setMicAvailable] = useState(false)
  const [cameraAvailable, setCameraAvailable] =
    useState(false)

  const [mediaError, setMediaError] = useState('')
  const [connectionStatus, setConnectionStatus] =
    useState('Starting camera and microphone...')

  const [participants, setParticipants] = useState<
    Participant[]
  >([])

  const [remoteStreams, setRemoteStreams] = useState<
    RemoteStreamItem[]
  >([])

  const [showChat, setShowChat] = useState(false)
  const [showParticipants, setShowParticipants] =
    useState(false)

  const [messages, setMessages] = useState<Message[]>([])
  const [newMessage, setNewMessage] = useState('')

  useEffect(() => {
    if (!meetingCode) {
      setMediaError('Meeting code is missing.')
      return
    }

    let cancelled = false

    const removePeerConnection = (socketId: string) => {
      const peerConnection =
        peerConnectionsRef.current.get(socketId)

      if (peerConnection) {
        peerConnection.ontrack = null
        peerConnection.onicecandidate = null
        peerConnection.onconnectionstatechange = null

        peerConnection.close()
        peerConnectionsRef.current.delete(socketId)
      }

      pendingCandidatesRef.current.delete(socketId)

      setRemoteStreams(current =>
        current.filter(
          remoteStream =>
            remoteStream.socketId !== socketId,
        ),
      )
    }

    const addRemoteStream = (
      socketId: string,
      stream: MediaStream,
    ) => {
      setRemoteStreams(current => {
        const existing = current.find(
          item => item.socketId === socketId,
        )

        if (existing?.stream === stream) {
          return current
        }

        return [
          ...current.filter(
            item => item.socketId !== socketId,
          ),
          {
            socketId,
            stream,
          },
        ]
      })
    }

    const createPeerConnection = (
      targetSocketId: string,
    ): RTCPeerConnection => {
      const existing =
        peerConnectionsRef.current.get(targetSocketId)

      if (existing) {
        return existing
      }

      const peerConnection = new RTCPeerConnection(
        ICE_CONFIGURATION,
      )

      const localStream = localStreamRef.current

      if (localStream) {
        localStream.getTracks().forEach(track => {
          peerConnection.addTrack(track, localStream)
        })
      }

      peerConnection.onicecandidate = event => {
        if (!event.candidate) {
          return
        }

        socketRef.current?.emit(
          'webrtc-ice-candidate',
          {
            targetSocketId,
            candidate: event.candidate.toJSON(),
          },
        )
      }

      peerConnection.ontrack = event => {
        const remoteStream = event.streams[0]

        if (remoteStream) {
          addRemoteStream(
            targetSocketId,
            remoteStream,
          )
        }
      }

      peerConnection.onconnectionstatechange = () => {
        const state = peerConnection.connectionState

        console.log(
          `WebRTC connection with ${targetSocketId}: ${state}`,
        )

        if (state === 'connected') {
          setConnectionStatus(
            'Connected to participant',
          )
        }

        if (
          state === 'failed' ||
          state === 'closed'
        ) {
          removePeerConnection(targetSocketId)
        }
      }

      peerConnectionsRef.current.set(
        targetSocketId,
        peerConnection,
      )

      return peerConnection
    }

    const addPendingIceCandidates = async (
      socketId: string,
    ) => {
      const peerConnection =
        peerConnectionsRef.current.get(socketId)

      const pendingCandidates =
        pendingCandidatesRef.current.get(socketId) || []

      if (!peerConnection?.remoteDescription) {
        return
      }

      for (const candidate of pendingCandidates) {
        try {
          await peerConnection.addIceCandidate(
            candidate,
          )
        } catch (error) {
          console.error(
            'Unable to add queued ICE candidate:',
            error,
          )
        }
      }

      pendingCandidatesRef.current.delete(socketId)
    }

    const createOffer = async (
      targetSocketId: string,
    ) => {
      try {
        const peerConnection =
          createPeerConnection(targetSocketId)

        const offer =
          await peerConnection.createOffer()

        await peerConnection.setLocalDescription(
          offer,
        )

        socketRef.current?.emit('webrtc-offer', {
          targetSocketId,
          offer: peerConnection.localDescription,
        })
      } catch (error) {
        console.error(
          'Unable to create WebRTC offer:',
          error,
        )
      }
    }

    const startMeeting = async () => {
      try {
        if (
          !navigator.mediaDevices?.getUserMedia
        ) {
          throw new Error(
            'Camera and microphone are not supported in this browser.',
          )
        }

        const localStream = await requestMeetingMedia()

        if (cancelled) {
          localStream
            .getTracks()
            .forEach(track => track.stop())

          return
        }

        localStreamRef.current = localStream

        const videoTrack =
          localStream.getVideoTracks()[0]

        const audioTrack =
          localStream.getAudioTracks()[0]

        if (videoTrack) {
          videoTrack.enabled = initialCameraOn

          setCameraAvailable(true)
          setCameraOn(initialCameraOn)
        } else {
          setCameraAvailable(false)
          setCameraOn(false)
        }

        if (audioTrack) {
          audioTrack.enabled = initialMicOn

          setMicAvailable(true)
          setMicOn(initialMicOn)
        } else {
          setMicAvailable(false)
          setMicOn(false)
        }

        if (localVideoRef.current) {
          localVideoRef.current.srcObject =
            localStream

          void localVideoRef.current
            .play()
            .catch(error => {
              console.warn(
                'Local video autoplay was blocked:',
                error,
              )
            })
        }

        setMediaError('')
        setConnectionStatus(
          'Connecting to meeting server...',
        )

        const socket = io(SOCKET_URL, {
          withCredentials: true,
          transports: ['websocket', 'polling'],
        })

        socketRef.current = socket

        socket.on('connect', () => {
          console.log(
            'Socket connected:',
            socket.id,
          )

          setConnectionStatus(
            'Connected to meeting server',
          )

          socket.emit('join-room', {
            roomId: meetingCode,
            name: user?.name || 'Guest',
            isHost,
          })
        })

        socket.on('connect_error', error => {
          console.error(
            'Socket connection error:',
            error,
          )

          setConnectionStatus(
            'Unable to connect to meeting server',
          )
        })

        socket.on(
          'existing-participants',
          (
            existingParticipants: Participant[],
          ) => {
            existingParticipants.forEach(
              participant => {
                void createOffer(
                  participant.socketId,
                )
              },
            )
          },
        )

        socket.on(
          'webrtc-offer',
          async ({
            fromSocketId,
            offer,
          }: OfferPayload) => {
            try {
              const peerConnection =
                createPeerConnection(fromSocketId)

              await peerConnection.setRemoteDescription(
                offer,
              )

              await addPendingIceCandidates(
                fromSocketId,
              )

              const answer =
                await peerConnection.createAnswer()

              await peerConnection.setLocalDescription(
                answer,
              )

              socket.emit('webrtc-answer', {
                targetSocketId: fromSocketId,
                answer:
                  peerConnection.localDescription,
              })
            } catch (error) {
              console.error(
                'Unable to process WebRTC offer:',
                error,
              )
            }
          },
        )

        socket.on(
          'webrtc-answer',
          async ({
            fromSocketId,
            answer,
          }: AnswerPayload) => {
            try {
              const peerConnection =
                peerConnectionsRef.current.get(
                  fromSocketId,
                )

              if (!peerConnection) {
                return
              }

              await peerConnection.setRemoteDescription(
                answer,
              )

              await addPendingIceCandidates(
                fromSocketId,
              )
            } catch (error) {
              console.error(
                'Unable to process WebRTC answer:',
                error,
              )
            }
          },
        )

        socket.on(
          'webrtc-ice-candidate',
          async ({
            fromSocketId,
            candidate,
          }: IceCandidatePayload) => {
            const peerConnection =
              peerConnectionsRef.current.get(
                fromSocketId,
              )

            if (
              !peerConnection ||
              !peerConnection.remoteDescription
            ) {
              const existingCandidates =
                pendingCandidatesRef.current.get(
                  fromSocketId,
                ) || []

              pendingCandidatesRef.current.set(
                fromSocketId,
                [
                  ...existingCandidates,
                  candidate,
                ],
              )

              return
            }

            try {
              await peerConnection.addIceCandidate(
                candidate,
              )
            } catch (error) {
              console.error(
                'Unable to add ICE candidate:',
                error,
              )
            }
          },
        )

        socket.on(
          'participants-updated',
          (updatedParticipants: Participant[]) => {
            setParticipants(
              updatedParticipants,
            )
          },
        )

        socket.on(
          'participant-left',
          ({
            socketId,
          }: ParticipantLeftPayload) => {
            removePeerConnection(socketId)
          },
        )

        socket.on(
          'receive-message',
          (message: Message) => {
            setMessages(current => [
              ...current,
              message,
            ])
          },
        )
      } catch (error) {
        const mediaError = error as DOMException

        console.error(
          'Unable to access media devices:',
          mediaError,
        )

        setCameraAvailable(false)
        setMicAvailable(false)
        setCameraOn(false)
        setMicOn(false)

        setConnectionStatus(
          'Camera and microphone unavailable',
        )

        if (
          mediaError.name === 'NotAllowedError'
        ) {
          setMediaError(
            'Camera and microphone permission was denied. Allow permission from the browser address bar and reload the page.',
          )
        } else if (
          mediaError.name === 'NotFoundError'
        ) {
          setMediaError(
            'No camera or microphone was found.',
          )
        } else if (
          mediaError.name === 'NotReadableError'
        ) {
          setMediaError(
            'The camera or microphone is already being used by another application.',
          )
        } else {
          setMediaError(
            mediaError.message ||
              'Unable to start camera and microphone.',
          )
        }
      }
    }

    void startMeeting()

    return () => {
      cancelled = true

      socketRef.current?.emit(
        'leave-room',
        meetingCode,
      )

      socketRef.current?.disconnect()
      socketRef.current = null

      peerConnectionsRef.current.forEach(
        peerConnection => {
          peerConnection.ontrack = null
          peerConnection.onicecandidate = null
          peerConnection.onconnectionstatechange =
            null

          peerConnection.close()
        },
      )

      peerConnectionsRef.current.clear()
      pendingCandidatesRef.current.clear()

      localStreamRef.current
        ?.getTracks()
        .forEach(track => track.stop())

      localStreamRef.current = null

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = null
      }
    }
  }, [
    meetingCode,
    user?.name,
    isHost,
    initialMicOn,
    initialCameraOn,
  ])

  const toggleMic = () => {
    const audioTrack =
      localStreamRef.current?.getAudioTracks()[0]

    if (!audioTrack) {
      return
    }

    audioTrack.enabled = !audioTrack.enabled
    setMicOn(audioTrack.enabled)
  }

  const toggleCamera = () => {
    const videoTrack =
      localStreamRef.current?.getVideoTracks()[0]

    if (!videoTrack) {
      return
    }

    videoTrack.enabled = !videoTrack.enabled
    setCameraOn(videoTrack.enabled)
  }

  const handleLeave = () => {
    socketRef.current?.emit(
      'leave-room',
      meetingCode,
    )

    socketRef.current?.disconnect()

    peerConnectionsRef.current.forEach(
      peerConnection => {
        peerConnection.close()
      },
    )

    localStreamRef.current
      ?.getTracks()
      .forEach(track => track.stop())

    navigate('/meetings')
  }

  const sendMessage = () => {
    const message = newMessage.trim()

    if (!message) {
      return
    }

    socketRef.current?.emit('send-message', {
      roomId: meetingCode,
      message,
      senderName: user?.name || 'Guest',
    })

    setNewMessage('')
  }

  const getParticipantName = (
    socketId: string,
  ) => {
    const participant = participants.find(
      item => item.socketId === socketId,
    )

    return participant?.name || 'Participant'
  }

  const isParticipantHost = (
    socketId: string,
  ) => {
    return participants.find(
      item => item.socketId === socketId,
    )?.isHost
  }

  return (
    <div className="fixed inset-0 flex flex-col bg-gray-950">
      {/* Header */}
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-gray-800 bg-gray-900 px-6">
        <div className="flex items-center gap-3">
          <span className="font-bold text-white">
            IntellMeet
          </span>

          <span className="text-gray-500">|</span>

          <span className="text-sm text-gray-300">
            {meetingTitle}
          </span>

          <span className="hidden text-sm text-gray-500 md:inline">
            Room: {meetingCode}
          </span>

          {isHost && (
            <span className="rounded-full bg-blue-600/20 px-2 py-0.5 text-xs text-blue-400">
              Host
            </span>
          )}
        </div>

        <div className="flex items-center gap-4">
          <span className="hidden text-sm text-gray-400 lg:block">
            {connectionStatus}
          </span>

          <button
            type="button"
            onClick={handleLeave}
            className="flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
          >
            <PhoneOff size={14} />
            Leave
          </button>
        </div>
      </div>

      {mediaError && (
        <div className="flex items-start gap-3 border-b border-red-900 bg-red-950/70 px-6 py-3 text-sm text-red-200">
          <AlertCircle
            size={17}
            className="mt-0.5 shrink-0"
          />

          <span>{mediaError}</span>
        </div>
      )}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Main video area */}
        <div className="flex min-w-0 flex-1 flex-col p-4 md:p-6">
          <div
            className={`grid min-h-0 flex-1 gap-4 overflow-y-auto ${
              remoteStreams.length > 0
                ? 'grid-cols-1 lg:grid-cols-2'
                : 'grid-cols-1'
            }`}
          >
            {/* Local video */}
            <div className="relative min-h-64 overflow-hidden rounded-2xl border border-gray-800 bg-gray-900">
              <video
                ref={localVideoRef}
                autoPlay
                muted
                playsInline
                className={`absolute inset-0 h-full w-full scale-x-[-1] object-cover ${
                  cameraAvailable && cameraOn
                    ? 'opacity-100'
                    : 'opacity-0'
                }`}
              />

              {(!cameraAvailable ||
                !cameraOn) && (
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  {user?.avatar ? (
                    <img
                      src={user.avatar}
                      alt="User avatar"
                      className="mb-4 h-24 w-24 rounded-full border-2 border-blue-500 object-cover"
                    />
                  ) : (
                    <div className="mb-4 flex h-24 w-24 items-center justify-center rounded-full bg-blue-600 text-4xl font-bold text-white">
                      {user?.name
                        ?.charAt(0)
                        ?.toUpperCase() || 'U'}
                    </div>
                  )}

                  <p className="font-medium text-white">
                    {user?.name || 'You'}
                  </p>

                  <p className="mt-1 text-sm text-gray-500">
                    {!cameraAvailable
                      ? 'Camera unavailable'
                      : 'Camera off'}
                  </p>
                </div>
              )}

              <div className="absolute bottom-4 left-4 rounded-lg bg-black/60 px-3 py-1 text-sm text-white">
                {user?.name || 'You'}
                {isHost ? ' (Host)' : ' (You)'}
              </div>
            </div>

            {/* Remote videos */}
            {remoteStreams.map(
              ({ socketId, stream }) => (
                <div
                  key={socketId}
                  className="relative min-h-64 overflow-hidden rounded-2xl border border-gray-800 bg-gray-900"
                >
                  <RemoteVideo stream={stream} />

                  <div className="absolute bottom-4 left-4 rounded-lg bg-black/60 px-3 py-1 text-sm text-white">
                    {getParticipantName(socketId)}
                    {isParticipantHost(socketId)
                      ? ' (Host)'
                      : ''}
                  </div>
                </div>
              ),
            )}
          </div>

          {remoteStreams.length === 0 &&
            !mediaError && (
              <p className="mt-3 text-center text-sm text-gray-500">
                Waiting for another participant to
                join...
              </p>
            )}

          {/* Controls */}
          <div className="mt-5 flex items-center justify-center gap-4">
            <button
              type="button"
              onClick={toggleMic}
              disabled={!micAvailable}
              title={
                micOn
                  ? 'Mute microphone'
                  : 'Unmute microphone'
              }
              className={`flex h-12 w-12 items-center justify-center rounded-full text-white ${
                !micAvailable
                  ? 'cursor-not-allowed bg-gray-800 text-gray-600'
                  : micOn
                    ? 'bg-gray-700 hover:bg-gray-600'
                    : 'bg-red-600 hover:bg-red-700'
              }`}
            >
              {micOn && micAvailable ? (
                <Mic size={18} />
              ) : (
                <MicOff size={18} />
              )}
            </button>

            <button
              type="button"
              onClick={toggleCamera}
              disabled={!cameraAvailable}
              title={
                cameraOn
                  ? 'Turn camera off'
                  : 'Turn camera on'
              }
              className={`flex h-12 w-12 items-center justify-center rounded-full text-white ${
                !cameraAvailable
                  ? 'cursor-not-allowed bg-gray-800 text-gray-600'
                  : cameraOn
                    ? 'bg-gray-700 hover:bg-gray-600'
                    : 'bg-red-600 hover:bg-red-700'
              }`}
            >
              {cameraOn &&
              cameraAvailable ? (
                <Video size={18} />
              ) : (
                <VideoOff size={18} />
              )}
            </button>

            <button
              type="button"
              onClick={() => {
                setShowChat(current => !current)
                setShowParticipants(false)
              }}
              className={`flex h-12 w-12 items-center justify-center rounded-full text-white ${
                showChat
                  ? 'bg-blue-600'
                  : 'bg-gray-700 hover:bg-gray-600'
              }`}
            >
              <MessageSquare size={18} />
            </button>

            <button
              type="button"
              onClick={() => {
                setShowParticipants(
                  current => !current,
                )
                setShowChat(false)
              }}
              className={`flex h-12 w-12 items-center justify-center rounded-full text-white ${
                showParticipants
                  ? 'bg-blue-600'
                  : 'bg-gray-700 hover:bg-gray-600'
              }`}
            >
              <Users size={18} />
            </button>

            <button
              type="button"
              onClick={handleLeave}
              className="flex h-12 w-12 items-center justify-center rounded-full bg-red-600 text-white hover:bg-red-700"
            >
              <PhoneOff size={18} />
            </button>
          </div>
        </div>

        {/* Chat panel */}
        {showChat && (
          <div className="flex w-80 shrink-0 flex-col border-l border-gray-800 bg-gray-900">
            <div className="flex items-center justify-between border-b border-gray-800 p-4">
              <h3 className="font-semibold text-white">
                Chat
              </h3>

              <button
                type="button"
                onClick={() => setShowChat(false)}
                className="text-gray-400 hover:text-white"
              >
                <X size={16} />
              </button>
            </div>

            <div className="flex-1 space-y-3 overflow-y-auto p-4">
              {messages.length === 0 ? (
                <p className="mt-8 text-center text-sm text-gray-500">
                  No messages yet
                </p>
              ) : (
                messages.map(message => (
                  <div
                    key={message.id}
                    className="space-y-1"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-blue-400">
                        {message.senderName}
                      </span>

                      <span className="text-xs text-gray-600">
                        {message.timestamp}
                      </span>
                    </div>

                    <p className="rounded-lg bg-gray-800 px-3 py-2 text-sm text-white">
                      {message.message}
                    </p>
                  </div>
                ))
              )}
            </div>

            <div className="flex gap-2 border-t border-gray-800 p-4">
              <input
                type="text"
                value={newMessage}
                onChange={event =>
                  setNewMessage(
                    event.target.value,
                  )
                }
                onKeyDown={event => {
                  if (event.key === 'Enter') {
                    sendMessage()
                  }
                }}
                placeholder="Type a message..."
                className="min-w-0 flex-1 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-white outline-none focus:border-blue-500"
              />

              <button
                type="button"
                onClick={sendMessage}
                className="rounded-lg bg-blue-600 p-2 text-white hover:bg-blue-700"
              >
                <Send size={16} />
              </button>
            </div>
          </div>
        )}

        {/* Participants panel */}
        {showParticipants && (
          <div className="flex w-80 shrink-0 flex-col border-l border-gray-800 bg-gray-900">
            <div className="flex items-center justify-between border-b border-gray-800 p-4">
              <h3 className="font-semibold text-white">
                Participants ({participants.length})
              </h3>

              <button
                type="button"
                onClick={() =>
                  setShowParticipants(false)
                }
                className="text-gray-400 hover:text-white"
              >
                <X size={16} />
              </button>
            </div>

            <div className="flex-1 space-y-3 overflow-y-auto p-4">
              {participants.length === 0 ? (
                <p className="mt-8 text-center text-sm text-gray-500">
                  No participants yet
                </p>
              ) : (
                participants.map(participant => (
                  <div
                    key={participant.socketId}
                    className="flex items-center gap-3"
                  >
                    <div className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-600 text-sm font-bold text-white">
                      {participant.name
                        .charAt(0)
                        .toUpperCase()}
                    </div>

                    <div>
                      <p className="text-sm font-medium text-white">
                        {participant.name}

                        {participant.socketId ===
                        socketRef.current?.id
                          ? ' (You)'
                          : ''}
                      </p>

                      {participant.isHost && (
                        <span className="text-xs text-blue-400">
                          Host
                        </span>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

export default MeetingRoom