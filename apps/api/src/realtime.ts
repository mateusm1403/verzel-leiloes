import type { Server as SocketServer } from 'socket.io';
import { getLiveSnapshot } from './auction-service.js';

export function attachAuctionSockets(io: SocketServer) {
  io.on('connection', (socket) => {
    const subscriptions = new Set<string>();
    socket.on('lot:join', async (lotId: unknown) => {
      if (typeof lotId !== 'string' || !/^[0-9a-f-]{36}$/i.test(lotId) || subscriptions.size >= 25) return;
      const snapshot = await getLiveSnapshot(lotId).catch(() => null);
      if (!snapshot) return;
      socket.join(lotId);
      subscriptions.add(lotId);
      socket.emit('lot:update', snapshot);
    });
    socket.on('lot:leave', (lotId: unknown) => {
      if (typeof lotId === 'string' && subscriptions.has(lotId)) {
        subscriptions.delete(lotId);
        socket.leave(lotId);
      }
    });
  });
}
