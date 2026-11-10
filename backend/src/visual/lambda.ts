import { handle } from 'hono/aws-lambda';
import { createVisualApp } from './app.ts';
import { enableAtomicConfirmation, visualAwsDependencies } from './aws.ts';

export const handler = handle(createVisualApp(enableAtomicConfirmation(visualAwsDependencies())));