FROM node:26 as build

RUN npm install -g pnpm@12.16.1

WORKDIR /opt/business-ecosystem-logic-proxy

COPY ./ .

RUN export USER=root && \
    pnpm install --frozen-lockfile && \
    pnpm build

FROM node:26 as main

LABEL MAINTAINER="Future Internet Consulting and Development Solutions S.L."

COPY --from=build /opt/business-ecosystem-logic-proxy /opt/business-ecosystem-logic-proxy

WORKDIR /opt/business-ecosystem-logic-proxy

RUN apt-get update && apt-get install -y curl

COPY ./docker/entrypoint.sh /

EXPOSE 8004

HEALTHCHECK --start-period=120s CMD curl --fail http://localhost:8004/health/live || exit 1

ENTRYPOINT ["/entrypoint.sh"]
