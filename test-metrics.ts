import { MetricsCollector } from './packages/server/src/metrics.js';

const metrics = new MetricsCollector();
for (let i = 0; i < 150; i++) {
    metrics.recordRequest(`command_${i}`, 'http', 10, true);
}

const snapshot = metrics.getSnapshot();
console.log('Total keys tracked:', Object.keys(snapshot.requests.byCommand).length);
console.log('Has overflow key:', 'unknown_or_overflow' in snapshot.requests.byCommand);
console.log('Overflow count:', snapshot.requests.byCommand['unknown_or_overflow']);
