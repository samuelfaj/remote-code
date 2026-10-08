#!/bin/sh
# Minimal stand-in for `distill models` in tests. It is NOT the shipped binary:
# it only makes the provider report's states deterministic.
case "${PROBE_MODE:-connected}" in
  unauthenticated)
    echo "You are not authenticated."
    echo "Default model: grok-4.6"
    echo "Available models:"
    echo "  - grok-4.6 (default)"
    ;;
  empty)
    echo "Default model: none"
    ;;
  connected)
    echo "Model 'remotecode-agent' is using its own API key."
    echo "Default model: remotecode-agent"
    echo "Available models:"
    echo "  - grok-4.6"
    echo "  * remotecode-agent (default)"
    ;;
esac
