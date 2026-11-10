import { randomUUID } from 'node:crypto';
import { S3Client, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Attachment } from '@servicecare/contracts';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const client = new S3Client({});
export async function uploadForm(customerId: string, contentType: string) {
  const key = `${customerId}/${randomUUID()}`;
  const form = await createPresignedPost(client, {
    Bucket: process.env.ATTACHMENTS_BUCKET!, Key: key, Expires: 300,
    Fields: { 'Content-Type': contentType },
    Conditions: [['content-length-range', 1, MAX_UPLOAD_BYTES], ['eq', '$Content-Type', contentType]],
  });
  return { ...form, key };
}
export async function validateAttachment(attachment: Attachment) {
  const object = await client.send(new HeadObjectCommand({ Bucket: process.env.ATTACHMENTS_BUCKET!, Key: attachment.key }));
  return object.ContentType === attachment.contentType && (object.ContentLength ?? 0) > 0 && (object.ContentLength ?? 0) <= MAX_UPLOAD_BYTES;
}
export async function downloadUrl(key: string) {
  return getSignedUrl(client, new GetObjectCommand({ Bucket: process.env.ATTACHMENTS_BUCKET!, Key: key, ResponseContentDisposition: 'attachment' }), { expiresIn: 120 });
}