---
id: deployment
title: Deployment Overview
sidebar_label: Overview
sidebar_position: 1
---

# Deployment

PlugPort is designed to deploy on free-tier cloud services with zero infrastructure cost.

## Deployment Options

| Method | Best For | Cost |
|--------|----------|------|
| [Docker Compose](./docker) | Local dev, self-hosted | Free |
| [Kubernetes](./kubernetes) | Production, auto-scaling | Varies |
| Railway | Quick cloud deploy | Free (500hrs/mo) |
| Vercel | Dashboard only | Free |
| Docker Hub | Container distribution | Free (public) |

## Quick Deploy: Railway

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template)

```bash
# Install Railway CLI
npm install -g @railway/cli

# Login and deploy
railway login
railway init
railway up
```

## Quick Deploy: Docker

```bash
docker run -p 8080:8080 -p 27017:27017 plugport/server:latest
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HTTP_PORT` | `8080` | HTTP API port |
| `WIRE_PORT` | `27017` | MongoDB wire protocol port |
| `HOST` | `0.0.0.0` | Bind address |
| `API_KEY` | none | API key for authentication |
| `LOG_LEVEL` | `info` | Logging level |
| `METRICS_ENABLED` | `true` | Enable /metrics endpoint |
| `MONADDB_ENDPOINT` | none | MonadDb RPC (uses in-memory if unset) |
| `MONADDB_PRIVATE_KEY` | none | Server wallet private key (64 hex chars) |
| `MAX_DOC_SIZE` | `1048576` | Maximum document size (bytes) |

> See `.env.example` at the project root for a fully commented template.

## Free Tier Matrix

| Service | Component | Free Tier Limit |
|---------|-----------|----------------|
| Railway | Server | 500 hours/month |
| Vercel | Dashboard | Unlimited deploys |
| Docker Hub | Images | Unlimited public repos |
| GitHub Actions | CI/CD | 2,000 minutes/month |
| npm | SDK packages | Unlimited public packages |
| PyPI | Python SDK | Unlimited public packages |
