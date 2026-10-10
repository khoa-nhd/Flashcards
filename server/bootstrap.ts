import type { Hono } from 'hono';
import {
  cardFields,
  newWordDefaults,
  notionProperties,
  reviewRules,
  vocabularyFields,
} from '../config/review.config.js';
import { calendarDateInTimeZone } from '../shared/dates.js';
import { createApp } from './create-app.js';
import { loadConfig, type AppConfig } from './env.js';
import { MockVocabularyRepository, mockCardFields } from './mock/mock-repository.js';
import { sampleRules } from './mock/sample-rules.js';
import { createNotionApi } from './notion/notion-client.js';
import { NotionVocabularyRepository } from './notion/notion-repository.js';
import { ReviewService } from './review-service.js';
import { VocabularyService } from './vocabulary-service.js';

interface Services {
  review: ReviewService;
  vocabulary: VocabularyService;
}

function buildServices(config: AppConfig): Services | null {
  if (config.issues.length > 0 || config.timeZone === null) return null;
  const { timeZone } = config;

  if (config.mode === 'mock') {
    const repository = new MockVocabularyRepository(calendarDateInTimeZone(new Date(), timeZone));
    return {
      review: new ReviewService({
        repository,
        rules: sampleRules,
        cardFields: mockCardFields,
        timeZone,
        writesRequested: true,
      }),
      vocabulary: new VocabularyService({
        catalog: repository,
        rules: sampleRules,
        defaults: newWordDefaults,
        timeZone,
        writesRequested: true,
      }),
    };
  }

  if (config.notion === null) return null;
  // One repository for both services, so the schema is resolved once.
  const repository = new NotionVocabularyRepository(createNotionApi(config.notion.apiKey), {
    databaseId: config.notion.databaseId,
    dataSourceId: config.notion.dataSourceId,
    properties: notionProperties,
    vocabularyFields,
    cardFields,
    rules: reviewRules,
    timeZone,
  });
  return {
    review: new ReviewService({
      repository,
      rules: reviewRules,
      cardFields,
      timeZone,
      writesRequested: config.writesRequested,
    }),
    vocabulary: new VocabularyService({
      catalog: repository,
      rules: reviewRules,
      defaults: newWordDefaults,
      timeZone,
      writesRequested: config.writesRequested,
    }),
  };
}

/** Wires configuration, data source and routes together. Shared by every entry point. */
export function buildApp(env: Record<string, string | undefined> = process.env): {
  app: Hono;
  config: AppConfig;
} {
  const config = loadConfig(env);
  const services = buildServices(config);
  return {
    app: createApp({ config, service: services?.review ?? null, vocabulary: services?.vocabulary ?? null }),
    config,
  };
}

let shared: ReturnType<typeof buildApp> | undefined;

/** One app per loaded copy of this module, built on first use. */
export function getApp(): ReturnType<typeof buildApp> {
  shared ??= buildApp();
  return shared;
}
