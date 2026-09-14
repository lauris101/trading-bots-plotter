# trading-bots-plotter. `just --list` for an overview.

set dotenv-load := true

# Run it (debug build, fast to compile); open http://127.0.0.1:8095
run:
    cargo run

# Run the optimized build
run-release:
    cargo run --release

# Format, clippy (deny warnings), tests
ci:
    cargo fmt --all --check
    cargo clippy --all-targets -- -D warnings
    cargo test
