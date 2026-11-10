import { handle } from 'hono/aws-lambda';
import { createApp } from './app.ts';
import { dynamoRepository } from './tickets/repository.ts';

export const handler = handle(createApp(dynamoRepository(), false, undefined, process.env.ORIGIN_VERIFY_TOKEN));