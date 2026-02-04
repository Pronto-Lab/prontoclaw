#!/bin/bash
# task-watch.sh - Real-time monitoring of agent tasks
#
# Usage:
#   ./scripts/task-watch.sh           # Watch all agents
#   ./scripts/task-watch.sh main      # Watch specific agent
#   ./scripts/task-watch.sh --once    # Show status once and exit
#
# Features:
#   - Real-time updates when tasks change
#   - Shows CURRENT_TASK.md and tasks/ directory
#   - Color-coded status (in_progress=yellow, completed=green, cancelled=red)
#   - Works with fswatch (macOS) or inotifywait (Linux)

set -euo pipefail

AGENTS_DIR="${HOME}/.openclaw/agents"
WATCH_AGENT="${1:-}"
ONCE_MODE=false

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
GRAY='\033[0;90m'
NC='\033[0m' # No Color
BOLD='\033[1m'

# Parse arguments
if [[ "${WATCH_AGENT}" == "--once" ]]; then
    ONCE_MODE=true
    WATCH_AGENT=""
fi

# Get list of agents to watch
get_agents() {
    if [[ -n "${WATCH_AGENT}" && "${WATCH_AGENT}" != "--once" ]]; then
        echo "${WATCH_AGENT}"
    else
        if [[ -d "${AGENTS_DIR}" ]]; then
            ls -1 "${AGENTS_DIR}" 2>/dev/null || true
        fi
    fi
}

# Format status with color
format_status() {
    local status="$1"
    case "${status}" in
        in_progress)
            echo -e "${YELLOW}●${NC} ${status}"
            ;;
        completed)
            echo -e "${GREEN}✓${NC} ${status}"
            ;;
        pending)
            echo -e "${BLUE}○${NC} ${status}"
            ;;
        blocked)
            echo -e "${RED}■${NC} ${status}"
            ;;
        cancelled)
            echo -e "${RED}✗${NC} ${status}"
            ;;
        *)
            echo "${status}"
            ;;
    esac
}

# Format priority with color
format_priority() {
    local priority="$1"
    case "${priority}" in
        urgent)
            echo -e "${RED}${BOLD}${priority}${NC}"
            ;;
        high)
            echo -e "${YELLOW}${priority}${NC}"
            ;;
        medium)
            echo -e "${BLUE}${priority}${NC}"
            ;;
        low)
            echo -e "${GRAY}${priority}${NC}"
            ;;
        *)
            echo "${priority}"
            ;;
    esac
}

# Parse CURRENT_TASK.md and display
show_current_task() {
    local agent_id="$1"
    local task_file="${AGENTS_DIR}/${agent_id}/CURRENT_TASK.md"
    
    if [[ -f "${task_file}" ]]; then
        local content
        content=$(cat "${task_file}")
        
        # Check if there's an active task
        if echo "${content}" | grep -q "No task in progress\|No active focus task"; then
            echo -e "  ${GRAY}(idle)${NC}"
        elif echo "${content}" | grep -q "Last task ended with error"; then
            echo -e "  ${RED}(error - last task failed)${NC}"
        else
            # Extract task info
            local task
            task=$(echo "${content}" | grep -E "^\*\*Task:\*\*" | sed 's/\*\*Task:\*\* //' | head -1 || true)
            local focus
            focus=$(echo "${content}" | grep -E "^\*\*Focus:\*\*" | sed 's/\*\*Focus:\*\* //' | head -1 || true)
            
            if [[ -n "${task}" ]]; then
                echo -e "  ${CYAN}Current:${NC} ${task:0:60}..."
            fi
            if [[ -n "${focus}" ]]; then
                echo -e "  ${GRAY}Focus: ${focus}${NC}"
            fi
        fi
    else
        echo -e "  ${GRAY}(no task file)${NC}"
    fi
}

# Show tasks in tasks/ directory
show_task_files() {
    local agent_id="$1"
    local tasks_dir="${AGENTS_DIR}/${agent_id}/tasks"
    
    if [[ -d "${tasks_dir}" ]]; then
        local task_files
        task_files=$(ls -1 "${tasks_dir}"/*.md 2>/dev/null | grep -E "^task_" || true)
        
        if [[ -n "${task_files}" ]]; then
            echo ""
            while IFS= read -r task_file; do
                if [[ -f "${tasks_dir}/${task_file}" ]]; then
                    local content
                    content=$(cat "${tasks_dir}/${task_file}")
                    
                    local task_id="${task_file%.md}"
                    local status
                    status=$(echo "${content}" | grep -E "^\- \*\*Status:\*\*" | sed 's/.*\*\*Status:\*\* //' | head -1 || echo "unknown")
                    local priority
                    priority=$(echo "${content}" | grep -E "^\- \*\*Priority:\*\*" | sed 's/.*\*\*Priority:\*\* //' | head -1 || echo "medium")
                    local desc
                    desc=$(echo "${content}" | sed -n '/^## Description/,/^##/p' | sed '1d;$d' | tr '\n' ' ' | head -c 50 || true)
                    
                    echo -e "    ${GRAY}${task_id}${NC}"
                    echo -e "      $(format_status "${status}") | $(format_priority "${priority}")"
                    if [[ -n "${desc}" ]]; then
                        echo -e "      ${desc}..."
                    fi
                fi
            done <<< "${task_files}"
        fi
    fi
}

# Display all agent statuses
display_status() {
    clear
    echo -e "${BOLD}╔══════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${BOLD}║               🦞 OpenClaw Task Monitor                       ║${NC}"
    echo -e "${BOLD}╚══════════════════════════════════════════════════════════════╝${NC}"
    echo ""
    echo -e "${GRAY}Updated: $(date '+%Y-%m-%d %H:%M:%S')${NC}"
    echo ""
    
    local agents
    agents=$(get_agents)
    
    if [[ -z "${agents}" ]]; then
        echo -e "${YELLOW}No agents found in ${AGENTS_DIR}${NC}"
        return
    fi
    
    while IFS= read -r agent_id; do
        if [[ -z "${agent_id}" ]]; then
            continue
        fi
        
        local agent_dir="${AGENTS_DIR}/${agent_id}"
        if [[ ! -d "${agent_dir}" ]]; then
            continue
        fi
        
        # Agent header
        local emoji=""
        case "${agent_id}" in
            main) emoji="🌙" ;;
            eden) emoji="💻" ;;
            seum) emoji="🔧" ;;
            yunseul) emoji="✨" ;;
            miri) emoji="📊" ;;
            onsae) emoji="🌿" ;;
            ieum) emoji="🔗" ;;
            *) emoji="🤖" ;;
        esac
        
        echo -e "${BOLD}${emoji} ${agent_id}${NC}"
        echo -e "${GRAY}────────────────────────────────────────${NC}"
        
        show_current_task "${agent_id}"
        show_task_files "${agent_id}"
        echo ""
    done <<< "${agents}"
    
    if [[ "${ONCE_MODE}" == "false" ]]; then
        echo -e "${GRAY}Press Ctrl+C to exit | Watching for changes...${NC}"
    fi
}

# Watch for file changes
watch_files() {
    local watch_paths=()
    local agents
    agents=$(get_agents)
    
    while IFS= read -r agent_id; do
        if [[ -n "${agent_id}" ]]; then
            watch_paths+=("${AGENTS_DIR}/${agent_id}")
        fi
    done <<< "${agents}"
    
    if [[ ${#watch_paths[@]} -eq 0 ]]; then
        echo "No agent directories to watch"
        exit 1
    fi
    
    # Try fswatch (macOS) first, then inotifywait (Linux)
    if command -v fswatch &> /dev/null; then
        fswatch -o "${watch_paths[@]}" --include '\.md$' | while read -r; do
            display_status
        done
    elif command -v inotifywait &> /dev/null; then
        while true; do
            inotifywait -q -e modify,create,delete -r "${watch_paths[@]}" --include '\.md$' 2>/dev/null || true
            display_status
        done
    else
        # Fallback: poll every 2 seconds
        echo -e "${YELLOW}Warning: fswatch/inotifywait not found. Using polling (2s interval).${NC}"
        echo -e "${GRAY}Install fswatch for better performance: brew install fswatch${NC}"
        echo ""
        while true; do
            display_status
            sleep 2
        done
    fi
}

# Main
main() {
    # Show initial status
    display_status
    
    # If --once, exit now
    if [[ "${ONCE_MODE}" == "true" ]]; then
        exit 0
    fi
    
    # Watch for changes
    watch_files
}

main
