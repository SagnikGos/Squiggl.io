// src/GameManager.js
import WordService from "./WordService.js";

let instance = null;
export class GameManager {
  constructor(io, redisClient) {
    this.io = io;
    this.redis = redisClient;
  }

  static instance(io, redisClient) {
    if (!instance) instance = new GameManager(io, redisClient);
    return instance;
  }

  static async handleRoundExpire(roomId) {
    if (instance) await instance._endRound(roomId);
  }

  async _getRoomState(roomId) {
    const data = await this.redis.get(`room:${roomId}`);
    if (data) return JSON.parse(data);
    const init = {
      players: {},
      drawerOrder: [],
      currentDrawerIdx: 0,
      word: null,
      wordMask: [],
      scene: null
    };
    await this.redis.set(`room:${roomId}`, JSON.stringify(init), { EX: 3600 });
    return init;
  }

  async _saveRoomState(roomId, state) {
    await this.redis.set(`room:${roomId}`, JSON.stringify(state), { EX: 3600 });
  }

  async handleJoin(socket, roomId, name) {
    const room = await this._getRoomState(roomId);
    room.players[socket.id] = room.players[socket.id] || { name, score: 0, hasGuessed: false };
    if (!room.drawerOrder.includes(socket.id)) room.drawerOrder.push(socket.id);
    await this._saveRoomState(roomId, room);

    socket.join(roomId);
    socket.emit("roomJoined", {
      players: room.players,
      currentDrawerIdx: room.currentDrawerIdx,
      scene: room.scene
    });
    this.io.to(roomId).emit("roomUpdate", { players: room.players });
  }

  async handleReconnect(socket, roomId, oldSocketId) {
    const room = await this._getRoomState(roomId);
    if (room.players[oldSocketId]) {
      room.players[socket.id] = room.players[oldSocketId];
      delete room.players[oldSocketId];
      room.drawerOrder = room.drawerOrder.map(id => id === oldSocketId ? socket.id : id);
      await this._saveRoomState(roomId, room);
      socket.join(roomId);
      socket.emit("reconnected", { players: room.players, scene: room.scene, currentDrawerIdx: room.currentDrawerIdx });
    } else {
      socket.emit("error", { message: "No session to reconnect" });
    }
  }

  async handleStartGame(socket, roomId) {
    const room = await this._getRoomState(roomId);
    const drawerId = room.drawerOrder[room.currentDrawerIdx];
    if (socket.id !== drawerId) return;
    await this._startRound(roomId);
    this.io.to(roomId).emit("gameStarted");
  }

  async _startRound(roomId) {
    const room = await this._getRoomState(roomId);
    room.word = WordService.random();
    room.wordMask = room.word.split("").map(() => "_");
    Object.values(room.players).forEach(p => p.hasGuessed = false);
    await this._saveRoomState(roomId, room);
    this.io.to(roomId).emit("roundStarted", { currentDrawerIdx: room.currentDrawerIdx, wordMask: room.wordMask });
    // Use Redis TTL to schedule round end
    await this.redis.set(`roundtimer:${roomId}`, "1", { EX: 60 });
  }

  async handleSceneUpdate(socket, roomId, elements, appState) {
    const room = await this._getRoomState(roomId);
    if (socket.id !== room.drawerOrder[room.currentDrawerIdx]) return;
    room.scene = { elements, appState };
    await this._saveRoomState(roomId, room);
    socket.to(roomId).emit("sceneDiff", { elements, appState });
  }

  async handleGuess(socket, roomId, guess) {
    const room = await this._getRoomState(roomId);
    const player = room.players[socket.id];
    if (!player || player.hasGuessed) return;
    if (guess.toLowerCase() === room.word.toLowerCase()) {
      player.hasGuessed = true;
      player.score += 10;
      await this._saveRoomState(roomId, room);
      this.io.to(roomId).emit("correctGuess", { playerId: socket.id });
    } else {
      this.io.to(roomId).emit("chatMessage", { from: socket.id, text: guess });
    }
  }

  async _endRound(roomId) {
    const room = await this._getRoomState(roomId);
    const scores = Object.entries(room.players).map(([id, p]) => ({ id, score: p.score }));
    room.currentDrawerIdx = (room.currentDrawerIdx + 1) % room.drawerOrder.length;
    await this._saveRoomState(roomId, room);
    this.io.to(roomId).emit("roundEnded", { scores, nextDrawerIdx: room.currentDrawerIdx });
    // Schedule next round after delay
    setTimeout(() => this._startRound(roomId), 5000);
  }

  async handleDisconnect(socket) {
    const keys = await this.redis.keys('room:*');
    for (const key of keys) {
      const roomId = key.split(':')[1];
      const room = await this._getRoomState(roomId);
      if (room.players[socket.id]) {
        delete room.players[socket.id];
        room.drawerOrder = room.drawerOrder.filter(id => id !== socket.id);
        await this._saveRoomState(roomId, room);
        if (socket.id === room.drawerOrder[room.currentDrawerIdx]) {
          await this._endRound(roomId);
        }
        if (Object.keys(room.players).length === 0) {
          await this.redis.del(key);
        } else {
          this.io.to(roomId).emit("roomUpdate", { players: room.players });
        }
      }
    }
  }
}

export function initGameManager(io, redisClient) {
  instance = GameManager.instance(io, redisClient);
  return instance;
}