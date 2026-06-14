.DEFAULT_GOAL := help

PIP  := backend/.venv/bin/pip
PORT ?= 8000

.PHONY: help setup setup-backend setup-frontend backend frontend dev clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

setup: setup-backend setup-frontend ## Install backend + frontend deps

setup-backend: ## Create venv and install Python deps
	@test -d backend/.venv || python3 -m venv backend/.venv
	@$(PIP) install -q --upgrade pip
	@$(PIP) install -q -r backend/requirements.txt
	@echo "backend deps installed"

setup-frontend: ## Install frontend deps
	@cd frontend && npm install

backend: ## Run the FastAPI backend (reload)
	@cd backend && ./.venv/bin/uvicorn app.main:app --reload --reload-dir app --port $(PORT)

frontend: ## Run the Vite dev server
	@cd frontend && npm run dev

dev: ## Run backend + frontend together (Ctrl-C stops both)
	@trap 'kill 0' INT TERM; \
	( cd backend && ./.venv/bin/uvicorn app.main:app --reload --reload-dir app --port $(PORT) ) & \
	( cd frontend && npm run dev ) & \
	wait

clean: ## Remove build artifacts, venv, node_modules
	rm -rf backend/.venv frontend/node_modules frontend/dist
	find backend -type d -name __pycache__ -prune -exec rm -rf {} +
