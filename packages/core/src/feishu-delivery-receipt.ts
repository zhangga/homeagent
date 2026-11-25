/** Local identity of a proactive Feishu notification that accepts direct replies. */
export interface FeishuDeliveryReceipt {
  appId: string;
  bindingId?: string;
  messageId: string;
}

export function isFeishuDeliveryReceipt(value: unknown): value is FeishuDeliveryReceipt {
  if (!value || typeof value !== "object") return false;
  const receipt = value as Partial<FeishuDeliveryReceipt>;
  const validId = (id: unknown) => typeof id === "string" && /^[a-zA-Z0-9_-]{1,512}$/u.test(id);
  return validId(receipt.appId) && validId(receipt.messageId) && (receipt.bindingId === undefined || validId(receipt.bindingId));
}

export function sameFeishuDeliveryReceipt(left: FeishuDeliveryReceipt, right: FeishuDeliveryReceipt): boolean {
  return left.appId === right.appId && left.bindingId === right.bindingId && left.messageId === right.messageId;
}
