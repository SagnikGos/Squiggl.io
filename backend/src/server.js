import express from "express";
import http from "http";
import { createClient } from "redis";
import { createAdapter } from "@socket.io/redis-adapter";
import { Server as IoServer } from "socket.io";
import cors from "cors";
import { initGameManager } from "./GameManager.js";

// Initialize Redis pub/sub and key-events
const pubClient = createClient({ url: process.env.REDIS_URL });
const subClient = pubClient.duplicate();
await pubClient.connect();
await subClient.connect();
// Enable keyspace notifications for expired events
await pubClient.configSet('notify-keyspace-events', 'Ex');
subClient.subscribe('__keyevent@0__:expired', (message) => {
  // Handle round timer expiration keys
  if (message.startsWith('roundtimer:')) {
    const roomId = message.split(':')[1];
    initGameManager.handleRoundExpire(roomId);
  }
});

const app = express();
app.use(cors());
const server = http.createServer(app);

// Socket.IO with Redis adapter
const io = new IoServer(server, {
  cors: { origin: process.env.FRONTEND_URL || '*' }
});
io.adapter(createAdapter(pubClient, subClient));

// Initialize GameManager singleton
initGameManager(io, pubClient);

io.on("connection", (socket) => {
  console.log(`Socket connected: ${socket.id}`);

  socket.on("joinRoom", (data) => {
    const { roomId, name } = data || {};
    if (!roomId || typeof roomId !== 'string' || !name || typeof name !== 'string') {
      return socket.emit("error", { message: "Invalid room ID or name" });
    }
    initGameManager(io, pubClient).handleJoin(socket, roomId.trim(), name.trim());
  });

  socket.on("reconnectRoom", ({ roomId, socketId }) => {
    initGameManager(io, pubClient).handleReconnect(socket, roomId.trim(), socketId.trim());
  });

  socket.on("startGame", (roomId) => {
    initGameManager(io, pubClient).handleStartGame(socket, roomId.trim());
  });

  socket.on("sceneUpdate", (payload) => {
    initGameManager(io, pubClient).handleSceneUpdate(
      socket,
      payload.roomId.trim(),
      payload.elements,
      payload.appState
    );
  });

  socket.on("guess", (payload) => {
    initGameManager(io, pubClient).handleGuess(
      socket,
      payload.roomId.trim(),
      payload.guess.trim()
    );
  });

  socket.on("disconnect", () => {
    initGameManager(io, pubClient).handleDisconnect(socket);
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () =>
  console.log(`Backend listening on http://localhost:${PORT}`)
);