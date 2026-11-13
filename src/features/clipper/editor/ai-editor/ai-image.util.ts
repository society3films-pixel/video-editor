/** A picture sent with an AI request (vision models). */
export interface AiImage {
  mediaType: "image/jpeg" | "image/png";
  base64: string;
}

type ChatMessage = { role: "system" | "user"; content: string };

/** OpenAI-style messages with the picture added to the last user message. */
export function withImage(messages: ChatMessage[], image?: AiImage): unknown[] {
  if (!image) return messages;
  const lastUser = messages.map((m) => m.role).lastIndexOf("user");
  return messages.map((message, index) =>
    index === lastUser
      ? {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: `data:${image.mediaType};base64,${image.base64}` } },
            { type: "text", text: message.content },
          ],
        }
      : message,
  );
}
