# trading-bots-plotter. `just --list` for an overview.

set dotenv-load := true

# Run it natively (debug build, fast to compile); open http://127.0.0.1:8095
run:
    cargo run

# Run the optimized build natively
run-release:
    cargo run --release

# Format, clippy (deny warnings), tests
ci:
    cargo fmt --all --check
    cargo clippy --all-targets -- -D warnings
    cargo test

# Build the image and start the container (reads .env)
up:
    docker compose up -d --build plotter

# Start the container plus the cloudflared sidecar that forwards Postgres
up-tunnel:
    docker compose --profile tunnel up -d --build

# Stop and remove the containers
down:
    docker compose --profile tunnel down

# Follow the plotter's log
logs:
    docker compose logs -f plotter
