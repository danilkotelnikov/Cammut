FROM node:22-alpine AS web
WORKDIR /w
COPY web/package.json web/package-lock.json ./web/
RUN cd web && npm ci
COPY web/ ./web/
RUN mkdir -p internal/web/dist && cd web && npm run build

FROM golang:1.26 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=web /w/internal/web/dist/ /src/internal/web/dist/
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/cammut ./cmd/cammut
RUN mkdir -p /data && chown 65532:65532 /data

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/cammut /cammut
COPY --from=build --chown=65532:65532 /data /data
USER 65532:65532
ENV CAMMUT_DB=/data/cammut.db
ENTRYPOINT ["/cammut"]
CMD ["serve", "-listen", "127.0.0.1:7421"]
