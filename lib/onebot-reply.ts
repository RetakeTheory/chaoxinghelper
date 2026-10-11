type Payload = Record<string, unknown>;
export class OneBotDeliveryError extends Error {
  constructor() {
    super("QQ 消息发送未获确认");
    this.name = "OneBotDeliveryError";
  }
}
export async function sendOneBotReply(call: (action: string, params: Payload) => Promise<Payload>, target: "private" | "group", id: string,
  text: string, render?: () => Promise<ArrayBuffer>) {
  const send = async (message: unknown[]) => {
    let result: Payload;
    try {
      result = await call(target === "group" ? "send_group_msg" : "send_private_msg", {
        [target === "group" ? "group_id" : "user_id"]: Number(id), message,
      });
    } catch {
      throw new OneBotDeliveryError();
    }
    if (result.status !== "ok" || Number(result.retcode) !== 0) throw new OneBotDeliveryError();
  };
  if (render) {
    let image: ArrayBuffer;
    try {
      image = await render();
    } catch {
      // Image rendering failed; retain a readable text result.
      await send([{ type: "text", data: { text } }]);
      return;
    }
    await send([{ type: "image", data: { file: "base64://" + Buffer.from(image).toString("base64") } }]);
    return;
  }
  await send([{ type: "text", data: { text } }]);
}
