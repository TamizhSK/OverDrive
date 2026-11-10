export const MAX_CHAT_IMAGES = 5;
export const MAX_CHAT_IMAGE_BYTES = 10 * 1024 * 1024;
export function validateChatImage(file: Pick<File, 'type' | 'size'>, currentCount: number) {
  if (currentCount >= MAX_CHAT_IMAGES) return 'You can attach up to five images.';
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return 'Choose a JPEG, PNG or WebP image.';
  if (file.size < 1 || file.size > MAX_CHAT_IMAGE_BYTES) return 'Each image must be between 1 byte and 10 MB.';
  return undefined;
}