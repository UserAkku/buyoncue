/** Transport-agnostic bot types so the conversation logic is testable without Telegram. */
export interface Button {
  text: string;
  data: string;
}

export interface Reply {
  /** Telegram HTML. */
  text: string;
  buttons?: Button[][];
}

export interface Actor {
  userId: string;
  chatId: string;
  chatType: string;
}

export interface CallbackResult {
  replies: Reply[];
  /** Short pop-up shown on the button press. */
  toast?: string;
}

export class UserFacingError extends Error {}
