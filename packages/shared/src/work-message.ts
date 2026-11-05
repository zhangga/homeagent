/** Transport-neutral, complete input retained until its work has settled. */
export interface WorkMessage {
  kind: "message";
  eventId: string;
  chatType: "p2p" | "group";
  chatId: string;
  senderId: string;
  text: string;
  messageId: string;
  threadId?: string;
  rootMessageId?: string;
  parentMessageId?: string;
  messageType?: string;
  mentionsBot: boolean;
  docLinks?: string[];
  createdAt: number;
}
