# trading-bots-plotter: one static binary on a slim Debian base.
# Dependencies compile in their own layer, so an edit to src/ or static/
# rebuilds only the crate itself.
FROM rust:1.98-slim-bookworm AS builder
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs \
 && cargo build --release --locked \
 && rm -rf src target/release/trading-bots-plotter* target/release/deps/trading_bots_plotter*
COPY src ./src
COPY static ./static
RUN cargo build --release --locked

FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/trading-bots-plotter /usr/local/bin/trading-bots-plotter
ENV PLOTTER_ADDR=0.0.0.0:8095 RUST_LOG=info
EXPOSE 8095
USER nobody
ENTRYPOINT ["/usr/local/bin/trading-bots-plotter"]
