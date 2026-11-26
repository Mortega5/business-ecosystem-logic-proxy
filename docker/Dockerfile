# `debug-nonroot` adds a shell to the image, to look inside a container; `nonroot` is the one to run
ARG DISTROLESS_TAG=nonroot

# The build and the production dependencies are plain JavaScript, so they are made once on the platform of the builder
# and copied to each architecture of the image
FROM --platform=$BUILDPLATFORM node:26-slim AS base

ARG PNPM_VERSION=12

RUN npm install -g pnpm@${PNPM_VERSION}

WORKDIR /opt/business-ecosystem-logic-proxy

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./


FROM base AS dependencies

RUN pnpm install --prod --frozen-lockfile


FROM base AS build

RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src

RUN pnpm build


FROM gcr.io/distroless/nodejs26-debian13:${DISTROLESS_TAG}

LABEL MAINTAINER="Future Internet Consulting and Development Solutions S.L."

WORKDIR /opt/business-ecosystem-logic-proxy

COPY --from=dependencies /opt/business-ecosystem-logic-proxy/node_modules ./node_modules
COPY --from=build /opt/business-ecosystem-logic-proxy/dist ./dist
COPY package.json ./
COPY config ./config
COPY portal ./portal

ENV NODE_ENV=production

EXPOSE 8004

# The image has no shell or curl, so the check is made with Node itself
HEALTHCHECK --start-period=120s CMD ["/nodejs/bin/node", "-e", "fetch('http://localhost:8004/health/live').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

# The entrypoint of the base image is `node`: it is the process that receives SIGTERM
CMD ["dist/main"]
