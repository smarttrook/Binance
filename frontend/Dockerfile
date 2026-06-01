FROM node:22-alpine

WORKDIR /app

COPY package.json ./

RUN npm config set fetch-retries 5 \
  && npm config set fetch-retry-mintimeout 20000 \
  && npm config set fetch-retry-maxtimeout 120000 \
  && npm install --legacy-peer-deps

COPY . .

ARG NEXT_PUBLIC_BACKEND_URL
ARG NEXT_PUBLIC_PRIVY_APP_ID

ENV NEXT_PUBLIC_BACKEND_URL=$NEXT_PUBLIC_BACKEND_URL
ENV NEXT_PUBLIC_PRIVY_APP_ID=$NEXT_PUBLIC_PRIVY_APP_ID
ENV NEXT_TELEMETRY_DISABLED=1

RUN echo "===== START NEXT BUILD =====" && npm run build

EXPOSE 3000

CMD ["npm", "start"]
