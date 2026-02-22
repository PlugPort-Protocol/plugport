---
id: kubernetes
title: Kubernetes Deployment
sidebar_label: Kubernetes
sidebar_position: 3
---

# Kubernetes Deployment

## Apply Manifests

```bash
kubectl apply -f deploy/k8s/plugport.yaml
```

This creates:
- **Namespace**: `plugport`
- **ConfigMap**: Environment variables
- **Server Deployment**: 2 replicas with health probes
- **Dashboard Deployment**: 1 replica
- **Services**: ClusterIP for internal communication
- **Ingress**: External HTTP access
- **HPA**: Auto-scaling (2-10 replicas, CPU target 70%)

## Verify

```bash
kubectl -n plugport get pods
kubectl -n plugport get services
kubectl -n plugport get hpa
```

## Port Forward for Local Testing

```bash
# HTTP API
kubectl -n plugport port-forward svc/plugport-server 8080:8080

# Wire Protocol
kubectl -n plugport port-forward svc/plugport-server 27017:27017

# Dashboard
kubectl -n plugport port-forward svc/plugport-dashboard 3000:3000
```

## Configuration

Edit the ConfigMap:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: plugport-config
  namespace: plugport
data:
  HTTP_PORT: "8080"
  WIRE_PORT: "27017"
  LOG_LEVEL: "info"
  METRICS_ENABLED: "true"
  # Uncomment for production:
  # MONADDB_ENDPOINT: "https://monaddb-rpc.monad.xyz/v1"
```

For production, store the wallet key in a Secret:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: plugport-secrets
  namespace: plugport
type: Opaque
stringData:
  MONADDB_PRIVATE_KEY: "your_64_char_hex_key"
```

## Scaling

```bash
# Manual scaling
kubectl -n plugport scale deployment plugport-server --replicas=5

# HPA auto-scales based on CPU
kubectl -n plugport get hpa plugport-server-hpa
```
