---
id: docker
title: Docker Deployment
sidebar_label: Docker
sidebar_position: 2
---

# Docker Deployment

## Single Container

```bash
docker run -d \
  --name plugport \
  -p 8080:8080 \
  -p 27017:27017 \
  -e LOG_LEVEL=info \
  -e METRICS_ENABLED=true \
  # Uncomment for production (MonadDb storage):
  # -e MONADDB_ENDPOINT=https://monaddb-rpc.monad.xyz/v1 \
  # -e MONADDB_PRIVATE_KEY=your_64_char_hex_key \
  plugport/server:latest
```

## Full Stack (Docker Compose)

The full stack includes the server, dashboard, Prometheus, and Grafana.

```bash
cd deploy/docker
docker-compose up -d
```

### Services

| Service | URL | Credentials |
|---------|-----|-------------|
| PlugPort Server | `http://localhost:8080` | - |
| Wire Protocol | `mongodb://localhost:27017` | - |
| Dashboard | `http://localhost:3000` | - |
| Prometheus | `http://localhost:9090` | - |
| Grafana | `http://localhost:3001` | admin / plugport |

### docker-compose.yml

```yaml
services:
  plugport-server:
    image: plugport/server:latest
    ports:
      - "8080:8080"
      - "27017:27017"
    environment:
      - METRICS_ENABLED=true
      # Uncomment for production:
      # - MONADDB_ENDPOINT=https://monaddb-rpc.monad.xyz/v1
      # - MONADDB_PRIVATE_KEY=your_64_char_hex_key
    healthcheck:
      test: wget --spider http://localhost:8080/health
      interval: 10s

  plugport-dashboard:
    image: plugport/dashboard:latest
    ports:
      - "3000:3000"
    environment:
      - NEXT_PUBLIC_API_URL=http://plugport-server:8080
    depends_on:
      plugport-server:
        condition: service_healthy

  prometheus:
    image: prom/prometheus:v2.54.0
    ports:
      - "9090:9090"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml

  grafana:
    image: grafana/grafana:11.3.0
    ports:
      - "3001:3000"
    environment:
      - GF_SECURITY_ADMIN_PASSWORD=plugport
```

## Building Images

```bash
# Server
docker build -f deploy/docker/Dockerfile -t plugport/server .

# Dashboard
docker build -f deploy/docker/Dockerfile.dashboard -t plugport/dashboard .
```
