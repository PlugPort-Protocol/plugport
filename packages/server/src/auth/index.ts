// Auth module barrel export
export { getSessionOptions, type SessionData } from './session.js';
export { ApiKeyManager, type ApiKeyMetadata, type ApiKeyPermission, type GenerateKeyResult } from './api-key-manager.js';
export { AnalyticsRecorder, type AnalyticsEvent, type KeyAnalytics, type DaySummary } from './analytics-recorder.js';
export { AuthContractAdapter, getAuthContract, type OnChainKeyEntry, type ScramVerifier } from './auth-contract.js';
