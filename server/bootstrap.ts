import type { Hono } from 'hono';
import { cardFields, notionProperties, reviewRules } from '../config/review.config.js';
import { calendarDateInTimeZone } from '../shared/dates.js';
import { createApp } from './create-app.js';
import { loadConfig, type AppConfig } from './env.js';
import { MockVocabularyRepository, mockCardFields } from './mock/mock-repository.js';
import { sampleRules } from './mock/sample-rules.js';
import { createNotionApi } from './notion/notion-client.js';
import { NotionVocabularyRepository } from './notion/notion-repository.js';
import { ReviewService } from './review-service.js';

function buildService(config: AppConfig): ReviewService | null {
  if (config.issues.length > 0 || config.timeZone === null) return null;
  const { timeZone } = config;

  if (config.mode === 'mock') {
    return new ReviewService({
      repository: new MockVocabularyRepository(calendarDateInTimeZone(new Date(), timeZone)),
      rules: sampleRules,
      cardFields: mockCardFields,
      timeZone,
      writesRequested: true,
    });
  }

  if (config.notion === null) return null;
  return new ReviewService({
    repository: new NotionVocabularyRepository(createNotionApi(config.notion.apiKey), {
      databaseId: config.notion.databaseId,
      dataSourceId: config.notion.dataSourceId,
      properties: notionProperties,
      cardFields,
      rules: reviewRules,
      timeZone,
    }),
    rules: reviewRules,
    cardFields,
    timeZone,
    writesRequested: config.writesRequested,
  });
}

/** Wires configuration, data source and routes together. Shared by every entry point. */
export function buildApp(env: Record<string, string | undefined> = process.env): {
  app: Hono;
  config: AppConfig;
} {
  const config = loadConfig(env);
  return { app: createApp({ config, service: buildService(config) }), config };
}

let shared: ReturnType<typeof buildApp> | undefined;

/** One app per loaded copy of this module, built on first use. */
export function getApp(): ReturnType<typeof buildApp> {
  shared ??= buildApp();
  return shared;
}
