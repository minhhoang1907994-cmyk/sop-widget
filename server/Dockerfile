# Bản dựng cho môi trường phát triển bằng Docker Compose.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
COPY db ./db
RUN npm run build

FROM node:24-slim AS runtime
ENV NODE_ENV=production
ENV TZ=UTC
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
RUN mkdir -p /data/reports
EXPOSE 8080
CMD ["node", "dist/src/index.js"]
