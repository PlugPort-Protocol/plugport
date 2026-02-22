---
id: monitoring
title: Monitoring & Metrics
sidebar_label: Monitoring
sidebar_position: 4
---

# Monitoring & Metrics

PlugPort exposes Prometheus-compatible metrics and a JSON metrics API.

## Prometheus Metrics

### Endpoint

```
GET /metrics
```

### Available Metrics

| Metric | Type | Description |
|--------|------|-------------|
| `plugport_requests_total` | Counter | Total requests by command |
| `plugport_request_duration_ms` | Histogram | Request latency |
| `plugport_errors_total` | Counter | Errors by code |
| `plugport_storage_keys` | Gauge | Total keys in storage |
| `plugport_storage_bytes` | Gauge | Estimated storage size |

### Prometheus Configuration

```yaml
# prometheus.yml
scrape_configs:
  - job_name: 'plugport'
    static_configs:
      - targets: ['plugport-server:8080']
    metrics_path: '/metrics'
    scrape_interval: 5s
```

## JSON Metrics API

For the dashboard and custom integrations:

```bash
curl http://localhost:8080/api/v1/metrics
```

```json
{
  "requests": {
    "total": 1234,
    "byCommand": { "find": 500, "insert": 300 },
    "byProtocol": { "http": 1000, "wire": 234 }
  },
  "latency": {
    "p50": 2.1,
    "p95": 12.5,
    "p99": 45.0,
    "avg": 5.3
  },
  "errors": { "total": 12, "byCode": { "11000": 5 } },
  "storage": { "keyCount": 5678, "estimatedSizeBytes": 123456 },
  "uptime": 3600
}
```

## Grafana Dashboard

The Docker Compose stack includes Grafana pre-configured with Prometheus:

```bash
cd deploy/docker && docker-compose up -d
# Grafana: http://localhost:3001 (admin/plugport)
```

### Recommended Panels

| Panel | Query |
|-------|-------|
| Request Rate | `rate(plugport_requests_total[5m])` |
| P95 Latency | `histogram_quantile(0.95, plugport_request_duration_ms)` |
| Error Rate | `rate(plugport_errors_total[5m])` |
| Storage Keys | `plugport_storage_keys` |

## Health Checks

```bash
# Quick health check
curl http://localhost:8080/health

# Kubernetes readiness/liveness probes are pre-configured
# in deploy/k8s/plugport.yaml
```
