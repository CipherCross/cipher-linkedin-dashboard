# Single image that serves the built SPA + the /api endpoints (server/index.ts).
# Build once; each team's container is the same image with a different env file.

# --- build the SPA --------------------------------------------------------
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build         # tsc -b && vite build -> dist/

# --- runtime: serve SPA + API via tsx -------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
# Only runtime deps (tsx, hono, ai SDK, supabase-js, jose, node-cron...).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
# Server + handlers run as TypeScript via tsx; ship the source they need.
COPY tsconfig.json ./tsconfig.json
COPY api ./api
COPY server ./server
COPY --from=build /app/dist ./dist
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["npm", "run", "start"]
