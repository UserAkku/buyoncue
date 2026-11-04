/** Transport-agnostic bot types so the conversation logic is testable without Telegram. */
export interface Button {
  text: string;
  /** Callback payload (max 64 bytes). Exactly one of `data` or `url` is set. */
  data?: string;
  /** Opens a web page (https). Used for the GitHub connect links. */
  url?: string;
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
  /** Telegram first name, only used to label the account on the browser confirmation page. */
  displayName?: string;
}

export interface CallbackResult {
  replies: Reply[];
  /** Short pop-up shown on the button press. */
  toast?: string;
}

export class UserFacingError extends Error {}
