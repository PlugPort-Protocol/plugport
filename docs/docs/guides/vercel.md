---
title: Deploying to Vercel
sidebar_position: 4
---

# Deploying the Dashboard to Vercel

The PlugPort dashboard is a Next.js 15 application. Vercel is the optimal hosting platform since they created Next.js. Deploying is free and takes just a few clicks.

> **Note**: This guide is for deploying the **Dashboard** (`packages/dashboard`). The core database server (`packages/server`) requires a persistent runtime (like Railway, Render, or AWS) because it runs a long-running TCP wire protocol server (port 27017) and an HTTP server. Vercel is designed for serverless functions and frontend apps, so it cannot host the core database server.

## Prerequisites

1. Your code must be pushed to a Git repository (GitHub, GitLab, or Bitbucket)
2. You must have a running PlugPort Server deployed elsewhere (e.g., Railway, Render, Fly.io, or an EC2 instance)
3. A free [Vercel account](https://vercel.com/signup)

## Step-by-Step Deployment

### 1. Import Project

1. Go to your Vercel Dashboard and click **Add New...** → **Project**
2. Connect your Git provider and select the repository containing your PlugPort monorepo
3. Click **Import**

### 2. Configure Monorepo Settings

Since PlugPort is a monorepo, you need to point Vercel to the dashboard application:

1. **Project Name**: `plugport-dashboard` (or whatever you prefer)
2. **Framework Preset**: Next.js
3. **Root Directory**: Click "Edit" and select `packages/dashboard`

![Vercel Root Directory](/img/vercel/root-dir.png)

### 3. Build Settings

Vercel usually detects Next.js settings automatically, but verify these build settings are applied under **Build and Output Settings**:

- **Build Command**: `pnpm build` (or leave as default `next build`)
- **Output Directory**: `.next` (default)
- **Install Command**: `pnpm install` (default)

### 4. Environment Variables

Expand the **Environment Variables** section. You must provide the URL of your externally hosted PlugPort core server so the dashboard knows where to connect.

Add the following variable:

| Key | Value |
|---|---|
| `NEXT_PUBLIC_API_URL` | `https://your-plugport-server-url.com` |

*(Make sure you **do not** include `/api/v1` or a trailing slash in the URL)*

### 5. Deploy

Click the **Deploy** button. Vercel will:
1. Clone your repository
2. Install `pnpm` workspace dependencies
3. Build the Next.js dashboard
4. Deploy it to their global edge network

## Troubleshooting

### "API Connection Failed" Error
If your dashboard loads but shows an API connection error:
1. Verify `NEXT_PUBLIC_API_URL` is set correctly in Vercel settings
2. Ensure your hosted PlugPort server is actually running and publicly accessible
3. Check that your server is exposing HTTP on port 8080 (or whatever port your reverse proxy maps to)

### Build Fails (Missing Dependencies)
If the build fails finding shared packages (like `@plugport/sdk` or `@plugport/shared`), ensure Vercel is treating the project as a monorepo. It usually handles pnpm workspaces automatically as long as the install command runs from the workspace root (which it does when you set the Root Directory correctly in Step 2).
