import {
  WebSocketGateway,
  SubscribeMessage,
  WebSocketServer,
  OnGatewayDisconnect,
  OnGatewayInit,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { GameService } from './services/game.service';
import { RedisService } from '../../services/redis.service';
import { UserDataDto } from './dto/user-data.dto';

/**
 * How long to wait between a socket disconnect and actually kicking
 * the player out of their rooms. socket.io clients on flaky mobile
 * networks (Telegram WebView, mobile Safari, tab-switching) drop and
 * reconnect within a few seconds; this grace window lets the same
 * `telegramId` re-join via `handleJoinRoom` and cancel the pending
 * leave so other players don't see them ping in and out.
 *
 * Tuned to match the typical mobile reconnect (≤ 10s) plus headroom.
 */
const DISCONNECT_GRACE_PERIOD_MS = 20_000;

@WebSocketGateway({
  cors: {
    origin: '*',
  },
})
export class GameGateway implements OnGatewayDisconnect, OnGatewayInit {
  @WebSocketServer()
  server: Server;

  // Защита от дублирования действий
  private processingActions = new Map<string, boolean>();

  /**
   * Pending grace-period leave timers, keyed by `telegramId`. If the
   * same player reconnects (i.e. emits `join_room` again) before the
   * timer fires we cancel it and they stay seated.
   */
  private pendingDisconnects = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly gameService: GameService,
    private readonly redisService: RedisService,
  ) {}

  /**
   * Cancel any in-flight grace-period leave for `telegramId`. Called
   * from `handleJoinRoom` so a reconnect within the window keeps the
   * player seated. Safe to call when no timer is pending — just a
   * no-op.
   */
  private cancelPendingDisconnect(telegramId: string): void {
    const timer = this.pendingDisconnects.get(telegramId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.pendingDisconnects.delete(telegramId);
    console.log(
      `[disconnect-grace] ${telegramId} reconnected within ${DISCONNECT_GRACE_PERIOD_MS}ms, leave cancelled`,
    );
  }

  afterInit() {
    void this.redisService.subscribeToGameUpdates((roomId, gameState) => {
      this.server.to(roomId).emit('game_update', gameState);
    });

    // Подписываемся на обновления баланса
    void this.redisService.subscribeToBalanceUpdates((telegramId, balance) => {
      this.server.to(telegramId).emit('balanceUpdated', { balance });
    });

    // Очищаем мертвых игроков при старте сервера
    void this.redisService.cleanupDeadPlayers();
  }

  private getTelegramId(client: Socket): string | undefined {
    const id: unknown =
      client.handshake.query?.telegramId ||
      client.handshake.auth?.telegramId ||
      client.handshake.headers['x-telegram-id'];
    if (Array.isArray(id)) {
      return id[0] as string;
    }
    if (typeof id === 'string') {
      return id;
    }
    return undefined;
  }

  private getUserData(client: Socket): UserDataDto {
    const userData: unknown = client.handshake.auth?.userData || {};
    return userData as UserDataDto;
  }

  @SubscribeMessage('join_room')
  async handleJoinRoom(
    client: Socket,
    payload: { roomId: string },
  ): Promise<void> {
    const { roomId } = payload;
    const telegramId = this.getTelegramId(client);

    if (!telegramId) {
      console.error('No telegramId provided for join_room');
      client.emit('error', { message: 'Требуется авторизация (telegramId)' });
      return;
    }

    void client.join(roomId);

    // If this player had a pending grace-period leave (e.g. tab was
    // briefly backgrounded), cancel it — they're back. Other players
    // never see the leave, no rooms_updated churn.
    this.cancelPendingDisconnect(telegramId);

    const result = await this.gameService.joinRoom(roomId, telegramId);

    if (result.success) {
      client.emit('game_state', result.gameState);
    } else {
      console.error(`Error in join_room for ${telegramId}:`, result.error);
      client.emit('error', { message: result.error });
    }
  }

  @SubscribeMessage('subscribe_balance')
  handleSubscribeBalance(client: Socket): void {
    const telegramId = this.getTelegramId(client);

    if (telegramId) {
      void client.join(telegramId);
    } else {
      console.error('No telegramId provided for subscribe_balance');
      client.emit('error', { message: 'Требуется авторизация (telegramId)' });
    }
  }

  @SubscribeMessage('leave_room')
  async handleLeaveRoom(
    client: Socket,
    payload: { roomId: string },
  ): Promise<void> {
    const telegramId = this.getTelegramId(client);

    if (telegramId) {
      await this.gameService.leaveRoom(payload.roomId, telegramId);
      void client.leave(payload.roomId);
      const rooms = await this.gameService.getRooms();
      this.server.emit('rooms_updated', rooms);
    } else {
      console.error('No telegramId provided for leave_room');
      client.emit('error', { message: 'Требуется авторизация (telegramId)' });
    }
  }

  @SubscribeMessage('game_action')
  async handleGameAction(
    client: Socket,
    payload: {
      roomId: string;
      action: string;
      amount?: number;
    },
  ): Promise<void> {
    const { roomId, action, amount } = payload;
    const telegramId = this.getTelegramId(client);
    
    // 🔥 ИСПРАВЛЕННАЯ ЗАЩИТА ОТ ДУБЛИРОВАНИЯ
    // Используем client.id вместо telegramId для уникальности
    const clientKey = `${client.id}-${action}-${amount || 'null'}`;
    if (this.processingActions.has(clientKey)) {
      console.log(`[DUPLICATE_ACTION_BLOCKED] Blocked duplicate action: ${clientKey}`);
      return;
    }
    
    // Дополнительная защита с timestamp для критических действий
    const timestampKey = `${client.id}-${action}-${Date.now()}`;
    this.processingActions.set(clientKey, true);
    this.processingActions.set(timestampKey, true);
    
    // Очистка через 500ms для предотвращения накопления
    setTimeout(() => {
      this.processingActions.delete(clientKey);
      this.processingActions.delete(timestampKey);
    }, 500);
    

    try {
      if (telegramId) {
      const result = await this.gameService.processAction(
        roomId,
        telegramId,
        action,
        amount,
      );

      if (result.events) {
        result.events.forEach((event) => {
          if (event.to) {
            this.server.to(event.to).emit(event.name, event.payload);
          } else {
            this.server.to(roomId).emit(event.name, event.payload);
          }
        });
      }

      if (!result.success) {
        console.error(`Error in game_action for ${telegramId}:`, result.error);
        client.emit('error', { message: result.error });
      }
    } else {
      console.error('No telegramId provided for game_action');
      client.emit('error', { message: 'Требуется авторизация (telegramId)' });
    }
    } catch (error) {
      console.error('Error in handleGameAction:', error);
      client.emit('error', { message: 'Внутренняя ошибка сервера' });
    } finally {
      // Очищаем ключи через 1 секунду (дополнительная очистка)
      setTimeout(() => {
        this.processingActions.delete(clientKey);
        this.processingActions.delete(timestampKey);
      }, 1000);
    }
  }

  // УДАЛЕНО: WebSocket auto-fold - теперь используется только таймерный auto-fold

  @SubscribeMessage('chat_message')
  handleChatMessage(
    client: Socket,
    payload: { roomId: string; phrase: string },
  ): void {
    const telegramId = this.getTelegramId(client);
    if (!telegramId) {
      client.emit('error', { message: 'Требуется авторизация (telegramId)' });
      return;
    }

    const { roomId, phrase } = payload;

    // Broadcast to all clients in the room, including the sender
    this.server.to(roomId).emit('new_chat_message', {
      playerId: telegramId,
      phrase,
    });
  }

  @SubscribeMessage('sit_down')
  async handleSitDown(
    client: Socket,
    payload: { roomId: string; position: number; userData: UserDataDto },
  ): Promise<void> {
    const { roomId, position, userData } = payload;
    const telegramId = this.getTelegramId(client);

    if (telegramId) {
      const result = await this.gameService.sitDown(
        roomId,
        telegramId,
        position,
        userData,
      );
      if (!result.success) {
        console.error(`Error in sit_down for ${telegramId}:`, result.error);
        client.emit('error', { message: result.error });
      }
    } else {
      console.error('No telegramId provided for sit_down');
      client.emit('error', { message: 'Требуется авторизация (telegramId)' });
    }
  }

  async handleDisconnect(client: Socket): Promise<void> {
    const telegramId = this.getTelegramId(client);

    if (!telegramId) {
      return;
    }

    // Capture which rooms this player was in NOW (before the grace
    // timer fires) — Redis state can change during the wait window
    // (e.g. the player joins a different room from another tab) and
    // we want the leave to apply to the rooms they were actually
    // active in at disconnect time.
    let roomIds: string[] = [];
    try {
      const fetched = await this.redisService.getPlayerRooms(telegramId);
      if (Array.isArray(fetched)) roomIds = fetched;
    } catch (error) {
      console.error(
        `[disconnect-grace] failed to read rooms for ${telegramId}:`,
        error,
      );
      return;
    }

    if (roomIds.length === 0) return;

    // If a prior disconnect for the same telegramId is already
    // pending, replace it — its captured rooms are stale.
    const previous = this.pendingDisconnects.get(telegramId);
    if (previous !== undefined) clearTimeout(previous);

    console.log(
      `[disconnect-grace] ${telegramId} disconnected from ${roomIds.length} room(s), will leave in ${DISCONNECT_GRACE_PERIOD_MS}ms unless reconnected`,
    );

    const timer = setTimeout(() => {
      this.pendingDisconnects.delete(telegramId);
      void this.performGracePeriodLeave(telegramId, roomIds);
    }, DISCONNECT_GRACE_PERIOD_MS);

    this.pendingDisconnects.set(telegramId, timer);
  }

  /**
   * Actually kick the player out of their rooms after the grace
   * period elapsed without a reconnect. Split out from
   * `handleDisconnect` so the timeout callback can stay simple, and
   * so failures in `leaveRoom` are logged with full context.
   */
  private async performGracePeriodLeave(
    telegramId: string,
    roomIds: readonly string[],
  ): Promise<void> {
    console.log(
      `[disconnect-grace] ${telegramId} did not reconnect, leaving ${roomIds.length} room(s)`,
    );
    for (const roomId of roomIds) {
      try {
        await this.gameService.leaveRoom(roomId, telegramId);
      } catch (error) {
        console.error(
          `[disconnect-grace] leaveRoom(${roomId}, ${telegramId}) failed:`,
          error,
        );
      }
    }
    try {
      const rooms = await this.gameService.getRooms();
      this.server.emit('rooms_updated', rooms);
    } catch (error) {
      console.error(
        `[disconnect-grace] failed to broadcast rooms_updated after ${telegramId} left:`,
        error,
      );
    }
  }
}
