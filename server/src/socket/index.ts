import { Server, Socket } from 'socket.io'

interface Participant {
  socketId: string
  name: string
  isHost: boolean
}

interface SessionDescriptionPayload {
  type: 'offer' | 'answer' | 'pranswer' | 'rollback'
  sdp?: string
}

interface IceCandidatePayload {
  candidate: string
  sdpMid?: string | null
  sdpMLineIndex?: number | null
  usernameFragment?: string | null
}

interface JoinRoomPayload {
  roomId: string
  name: string
  isHost: boolean
}

interface MessagePayload {
  roomId: string
  message: string
  senderName: string
}

interface WebRTCOfferPayload {
  targetSocketId: string
  offer: SessionDescriptionPayload
}

interface WebRTCAnswerPayload {
  targetSocketId: string
  answer: SessionDescriptionPayload
}

interface IceCandidateSignalPayload {
  targetSocketId: string
  candidate: IceCandidatePayload
}

const rooms = new Map<string, Participant[]>()

const removeParticipantFromRoom = (
  io: Server,
  socket: Socket,
  roomId: string,
): void => {
  const participants = rooms.get(roomId)

  if (!participants) {
    return
  }

  const updatedParticipants = participants.filter(
    participant => participant.socketId !== socket.id,
  )

  if (updatedParticipants.length === 0) {
    rooms.delete(roomId)
  } else {
    rooms.set(roomId, updatedParticipants)
  }

  socket.leave(roomId)

  /*
   * Inform the remaining users so that they can remove
   * the disconnected participant's video and peer connection.
   */
  socket.to(roomId).emit('participant-left', {
    socketId: socket.id,
  })

  io.to(roomId).emit(
    'participants-updated',
    updatedParticipants,
  )

  console.log(`Socket ${socket.id} left room ${roomId}`)
}

export const initSocket = (io: Server): void => {
  io.on('connection', (socket: Socket) => {
    console.log(`Socket connected: ${socket.id}`)

    socket.on(
      'join-room',
      ({ roomId, name, isHost }: JoinRoomPayload) => {
        if (!roomId) {
          return
        }

        /*
         * Prevent duplicate participant entries when the client
         * reconnects or accidentally emits join-room more than once.
         */
        const currentParticipants = rooms.get(roomId) || []

        const participantsWithoutCurrentSocket =
          currentParticipants.filter(
            participant => participant.socketId !== socket.id,
          )

        /*
         * Send the participants already present in the room
         * only to the new participant.
         *
         * The new participant will create WebRTC offers for them.
         */
        socket.emit(
          'existing-participants',
          participantsWithoutCurrentSocket,
        )

        const participant: Participant = {
          socketId: socket.id,
          name: name || 'Guest',
          isHost: Boolean(isHost),
        }

        rooms.set(roomId, [
          ...participantsWithoutCurrentSocket,
          participant,
        ])

        socket.join(roomId)
        socket.data.roomId = roomId
        socket.data.participantName = participant.name

        /*
         * Notify users who were already in the room.
         */
        socket.to(roomId).emit('participant-joined', participant)

        /*
         * Send the complete participant list to everyone.
         */
        io.to(roomId).emit(
          'participants-updated',
          rooms.get(roomId),
        )

        console.log(
          `${participant.name} joined room ${roomId}`,
        )
      },
    )

    /*
     * Forward a WebRTC offer to one specific participant.
     */
    socket.on(
      'webrtc-offer',
      ({ targetSocketId, offer }: WebRTCOfferPayload) => {
        if (!targetSocketId || !offer) {
          return
        }

        io.to(targetSocketId).emit('webrtc-offer', {
          fromSocketId: socket.id,
          offer,
        })
      },
    )

    /*
     * Forward a WebRTC answer back to the participant
     * that originally created the offer.
     */
    socket.on(
      'webrtc-answer',
      ({ targetSocketId, answer }: WebRTCAnswerPayload) => {
        if (!targetSocketId || !answer) {
          return
        }

        io.to(targetSocketId).emit('webrtc-answer', {
          fromSocketId: socket.id,
          answer,
        })
      },
    )

    /*
     * ICE candidates contain possible network paths that
     * WebRTC can use to connect the two browsers.
     */
    socket.on(
      'webrtc-ice-candidate',
      ({
        targetSocketId,
        candidate,
      }: IceCandidateSignalPayload) => {
        if (!targetSocketId || !candidate) {
          return
        }

        io.to(targetSocketId).emit(
          'webrtc-ice-candidate',
          {
            fromSocketId: socket.id,
            candidate,
          },
        )
      },
    )

    /*
     * Existing room chat functionality.
     */
    socket.on(
      'send-message',
      ({
        roomId,
        message,
        senderName,
      }: MessagePayload) => {
        if (!roomId || !message.trim()) {
          return
        }

        io.to(roomId).emit('receive-message', {
          id: Date.now(),
          message: message.trim(),
          senderName: senderName || 'Guest',
          timestamp: new Date().toLocaleTimeString(),
        })
      },
    )

    socket.on('leave-room', (roomId: string) => {
      if (!roomId) {
        return
      }

      removeParticipantFromRoom(io, socket, roomId)

      socket.data.roomId = undefined
    })

    socket.on('disconnect', () => {
      const roomId = socket.data.roomId as string | undefined

      if (roomId) {
        removeParticipantFromRoom(io, socket, roomId)
      }

      console.log(`Socket disconnected: ${socket.id}`)
    })
  })
}