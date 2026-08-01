import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { useAuthStore } from '@/store/authStore'
import {
  AlertCircle,
  CheckCircle,
  Mic,
  MicOff,
  Video,
  VideoOff,
} from 'lucide-react'

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

const PreJoin = () => {
  const { meetingCode } = useParams()
  const { user } = useAuthStore()
  const navigate = useNavigate()
  const location = useLocation()

  const meetingTitle =
    (location.state as { meetingTitle?: string } | null)?.meetingTitle ||
    'Meeting'

  const isHost =
    (location.state as { isHost?: boolean } | null)?.isHost || false

  const videoRef = useRef<HTMLVideoElement>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)

  const [micOn, setMicOn] = useState(true)
  const [cameraOn, setCameraOn] = useState(true)

  const [cameraAvailable, setCameraAvailable] = useState(false)
  const [micAvailable, setMicAvailable] = useState(false)

  const [cameraError, setCameraError] = useState('')
  const [micError, setMicError] = useState('')
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    let mounted = true

    const startMedia = async () => {
      setIsLoading(true)

      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error(
            'Camera and microphone access is not supported in this browser.',
          )
        }

        const localStream = await requestMeetingMedia()

        if (!mounted) {
          localStream.getTracks().forEach((track) => track.stop())
          return
        }

        mediaStreamRef.current = localStream

        const videoTrack = localStream.getVideoTracks()[0]
        const audioTrack = localStream.getAudioTracks()[0]

        setCameraAvailable(Boolean(videoTrack))
        setMicAvailable(Boolean(audioTrack))
        setCameraOn(Boolean(videoTrack))
        setMicOn(Boolean(audioTrack))

        setCameraError('')
        setMicError('')

        /*
         * The video element is always rendered below.
         * Therefore videoRef.current exists when the stream is attached.
         */
        if (videoRef.current) {
          videoRef.current.srcObject = localStream

          try {
            await videoRef.current.play()
          } catch (playError) {
            console.warn('Video autoplay was prevented:', playError)
          }
        }
      } catch (error) {
        const mediaError = error as DOMException

        console.error('Unable to access media devices:', mediaError)

        setCameraAvailable(false)
        setMicAvailable(false)
        setCameraOn(false)
        setMicOn(false)

        const errorName = mediaError.name

        if (
          errorName === 'NotAllowedError' ||
          errorName === 'PermissionDeniedError'
        ) {
          const message =
            'Camera and microphone permission was denied. Allow access from the browser address bar.'

          setCameraError(message)
          setMicError(message)
        } else if (
          errorName === 'NotFoundError' ||
          errorName === 'DevicesNotFoundError'
        ) {
          setCameraError('No camera was found on this device.')
          setMicError('No microphone was found on this device.')
        } else if (
          errorName === 'NotReadableError' ||
          errorName === 'TrackStartError'
        ) {
          const message =
            'The camera or microphone is already being used by another application.'

          setCameraError(message)
          setMicError(message)
        } else if (errorName === 'OverconstrainedError') {
          const message =
            'The selected camera or microphone settings are not supported.'

          setCameraError(message)
          setMicError(message)
        } else {
          const message =
            mediaError.message ||
            'Unable to access the camera and microphone.'

          setCameraError(message)
          setMicError(message)
        }
      } finally {
        if (mounted) {
          setIsLoading(false)
        }
      }
    }

    void startMedia()

    return () => {
      mounted = false

      mediaStreamRef.current?.getTracks().forEach((track) => {
        track.stop()
      })

      mediaStreamRef.current = null

      if (videoRef.current) {
        videoRef.current.srcObject = null
      }
    }
  }, [])

  const toggleMic = () => {
    const audioTrack = mediaStreamRef.current?.getAudioTracks()[0]

    if (!audioTrack) {
      return
    }

    audioTrack.enabled = !audioTrack.enabled
    setMicOn(audioTrack.enabled)
  }

  const toggleCamera = () => {
    const videoTrack = mediaStreamRef.current?.getVideoTracks()[0]

    if (!videoTrack) {
      return
    }

    videoTrack.enabled = !videoTrack.enabled
    setCameraOn(videoTrack.enabled)
  }

  const stopMedia = () => {
    mediaStreamRef.current?.getTracks().forEach((track) => {
      track.stop()
    })

    mediaStreamRef.current = null

    if (videoRef.current) {
      videoRef.current.srcObject = null
    }
  }

  const handleJoin = () => {
    stopMedia()

    navigate(`/meeting-room/${meetingCode}`, {
      state: {
        meetingTitle,
        micOn,
        cameraOn,
        isHost,
      },
    })
  }

  const handleCancel = () => {
    stopMedia()
    navigate('/meetings')
  }

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-6">
      <div className="w-full max-w-4xl">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-white">
            {meetingTitle}
          </h1>

          <p className="text-gray-400 mt-2">
            Meeting Code:{' '}
            <span className="text-blue-400 font-mono font-semibold">
              {meetingCode}
            </span>
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          <div className="space-y-4">
            <div className="relative aspect-video bg-gray-900 rounded-2xl overflow-hidden border border-gray-800">
              {/*
                Keep the video mounted at all times.
                Hiding it conditionally was the main preview bug.
              */}
              <video
                ref={videoRef}
                autoPlay
                muted
                playsInline
                className={`absolute inset-0 w-full h-full object-cover scale-x-[-1] ${
                  cameraAvailable && cameraOn
                    ? 'opacity-100'
                    : 'opacity-0'
                }`}
              />

              {(!cameraAvailable || !cameraOn || isLoading) && (
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  {isLoading ? (
                    <>
                      <div className="w-10 h-10 rounded-full border-4 border-gray-700 border-t-blue-500 animate-spin" />
                      <p className="text-gray-400 text-sm mt-4">
                        Checking camera and microphone...
                      </p>
                    </>
                  ) : (
                    <>
                      {user?.avatar ? (
                        <img
                          src={user.avatar}
                          alt="User avatar"
                          className="w-20 h-20 rounded-full object-cover border-2 border-blue-500 mb-3"
                        />
                      ) : (
                        <div className="w-20 h-20 rounded-full bg-blue-600 flex items-center justify-center text-white text-3xl font-bold mb-3">
                          {user?.name?.charAt(0)?.toUpperCase() || 'U'}
                        </div>
                      )}

                      <p className="text-white font-medium">
                        {user?.name || 'User'}
                      </p>

                      <p className="text-gray-500 text-sm mt-1">
                        {!cameraAvailable
                          ? 'Camera unavailable'
                          : 'Camera off'}
                      </p>
                    </>
                  )}
                </div>
              )}

              <div className="absolute bottom-3 left-3 bg-black/60 text-white text-sm px-3 py-1 rounded-lg">
                {user?.name || 'User'}
              </div>
            </div>

            <div className="flex items-center justify-center gap-4">
              <button
                type="button"
                onClick={toggleMic}
                disabled={!micAvailable || isLoading}
                className={`flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium transition border ${
                  !micAvailable || isLoading
                    ? 'bg-gray-800 text-gray-600 border-gray-700 cursor-not-allowed'
                    : micOn
                      ? 'bg-green-600/20 text-green-400 border-green-500/30 hover:bg-green-600/30'
                      : 'bg-red-600/20 text-red-400 border-red-500/30 hover:bg-red-600/30'
                }`}
              >
                {micOn && micAvailable ? (
                  <Mic size={16} />
                ) : (
                  <MicOff size={16} />
                )}

                {!micAvailable
                  ? 'No Mic'
                  : micOn
                    ? 'Mic On'
                    : 'Mic Off'}
              </button>

              <button
                type="button"
                onClick={toggleCamera}
                disabled={!cameraAvailable || isLoading}
                className={`flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium transition border ${
                  !cameraAvailable || isLoading
                    ? 'bg-gray-800 text-gray-600 border-gray-700 cursor-not-allowed'
                    : cameraOn
                      ? 'bg-green-600/20 text-green-400 border-green-500/30 hover:bg-green-600/30'
                      : 'bg-red-600/20 text-red-400 border-red-500/30 hover:bg-red-600/30'
                }`}
              >
                {cameraOn && cameraAvailable ? (
                  <Video size={16} />
                ) : (
                  <VideoOff size={16} />
                )}

                {!cameraAvailable
                  ? 'No Camera'
                  : cameraOn
                    ? 'Camera On'
                    : 'Camera Off'}
              </button>
            </div>
          </div>

          <div className="flex flex-col justify-center space-y-6">
            <div className="bg-gray-900 rounded-2xl border border-gray-800 p-5 space-y-3">
              <h3 className="text-white font-semibold mb-3">
                Device Status
              </h3>

              <div className="flex items-start gap-3">
                {micAvailable ? (
                  <CheckCircle
                    size={16}
                    className="text-green-400 mt-0.5 shrink-0"
                  />
                ) : (
                  <AlertCircle
                    size={16}
                    className="text-red-400 mt-0.5 shrink-0"
                  />
                )}

                <div>
                  <span className="text-gray-300 text-sm">
                    Microphone —{' '}
                    {micAvailable
                      ? micOn
                        ? 'Ready'
                        : 'Muted'
                      : 'Not available'}
                  </span>

                  {micError && (
                    <p className="text-red-400 text-xs mt-1">
                      {micError}
                    </p>
                  )}
                </div>
              </div>

              <div className="flex items-start gap-3">
                {cameraAvailable ? (
                  <CheckCircle
                    size={16}
                    className="text-green-400 mt-0.5 shrink-0"
                  />
                ) : (
                  <AlertCircle
                    size={16}
                    className="text-red-400 mt-0.5 shrink-0"
                  />
                )}

                <div>
                  <span className="text-gray-300 text-sm">
                    Camera —{' '}
                    {cameraAvailable
                      ? cameraOn
                        ? 'Ready'
                        : 'Off'
                      : 'Not available'}
                  </span>

                  {cameraError && (
                    <p className="text-red-400 text-xs mt-1">
                      {cameraError}
                    </p>
                  )}
                </div>
              </div>
            </div>

            <div className="bg-gray-900 rounded-2xl border border-gray-800 p-5 space-y-3">
              <h3 className="text-white font-semibold mb-3">
                Meeting Info
              </h3>

              <div className="flex items-center justify-between gap-4">
                <span className="text-gray-400 text-sm">
                  Meeting Name
                </span>

                <span className="text-white text-sm font-medium text-right">
                  {meetingTitle}
                </span>
              </div>

              <div className="flex items-center justify-between gap-4">
                <span className="text-gray-400 text-sm">
                  Room Code
                </span>

                <span className="text-blue-400 font-mono text-sm font-semibold">
                  {meetingCode}
                </span>
              </div>

              <div className="flex items-center justify-between gap-4">
                <span className="text-gray-400 text-sm">
                  Joining as
                </span>

                <span className="text-white text-sm font-medium text-right">
                  {user?.name || 'User'}
                </span>
              </div>
            </div>

            <button
              type="button"
              onClick={handleJoin}
              disabled={isLoading}
              className="w-full bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-400 disabled:cursor-not-allowed text-white font-semibold py-4 rounded-xl transition text-lg"
            >
              {isLoading ? 'Checking Devices...' : 'Join Meeting'}
            </button>

            <button
              type="button"
              onClick={handleCancel}
              className="w-full bg-gray-800 hover:bg-gray-700 text-gray-300 font-medium py-3 rounded-xl transition"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default PreJoin