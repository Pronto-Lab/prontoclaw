---
name: design-system
description: Use when working with UI/UX design, design systems, component libraries, accessibility, or Figma integration. Provides access to design knowledge, WCAG guidelines, and Figma file manipulation via MCP servers.
homepage: https://design-systems-mcp.southleft.com/
metadata:
  {
    "openclaw":
      {
        "emoji": "🎨",
        "requires": { "bins": ["mcporter"] },
        "install":
          [
            {
              "id": "mcporter",
              "kind": "node",
              "package": "mcporter",
              "bins": ["mcporter"],
              "label": "Install mcporter CLI",
            },
          ],
      },
  }
---

# Design System Skill

Work with design systems, UI components, accessibility guidelines, and Figma using MCP servers.

## Available MCP Servers

| Server                  | Tools | Use Case                                                  |
| ----------------------- | ----- | --------------------------------------------------------- |
| `design-systems`        | 4     | Design knowledge: WCAG, DTCG, Material Design, Ant Design |
| `accessibility-scanner` | 24    | WCAG compliance checking, browser automation              |
| `figma`                 | 40    | Figma read/write (requires Desktop + plugin)              |

## Quick Reference

### Design Knowledge Search

```bash
# Search design principles
mcporter call design-systems.search_design_knowledge query="color contrast accessibility"

# Browse by category
mcporter call design-systems.browse_by_category category="accessibility"
mcporter call design-systems.browse_by_category category="tokens"
mcporter call design-systems.browse_by_category category="components"

# Get all tags
mcporter call design-systems.get_all_tags
```

**Categories:** figma, tokens, components, documentation, workflow, governance, accessibility, tools, case-studies, foundations

### Accessibility Scanning

```bash
# Navigate to page
mcporter call accessibility-scanner.browser_navigate url="https://example.com"

# Run accessibility scan
mcporter call accessibility-scanner.browser_run_accessibility_scan

# Take screenshot
mcporter call accessibility-scanner.browser_screenshot

# Close browser
mcporter call accessibility-scanner.browser_close
```

### Figma Operations

**Prerequisites:** Figma Desktop app running + Figma Talk plugin installed

```bash
# Get document info
mcporter call figma.get_document_info

# Get selection
mcporter call figma.get_selection

# Get node by ID
mcporter call figma.get_node_info node_id="123:456"

# Create text
mcporter call figma.create_text text="Hello World" x:100 y:100

# Create rectangle
mcporter call figma.create_rectangle x:0 y:0 width:100 height:100

# Set fill color (RGB 0-1)
mcporter call figma.set_fill_color node_id="123:456" r:0.2 g:0.4 b:0.8 a:1
```

## Workflows

### 1. Design System Compliance Check

```
1. Search design-systems for relevant guidelines
   mcporter call design-systems.search_design_knowledge query="button component best practices"

2. Review against WCAG standards
   mcporter call design-systems.browse_by_category category="accessibility"

3. Document compliance findings
```

### 2. Accessibility Audit

```
1. Navigate to target page
   mcporter call accessibility-scanner.browser_navigate url="<target_url>"

2. Run WCAG scan
   mcporter call accessibility-scanner.browser_run_accessibility_scan

3. Capture screenshot for documentation
   mcporter call accessibility-scanner.browser_screenshot

4. Close browser
   mcporter call accessibility-scanner.browser_close

5. Report findings with remediation guidance
```

### 3. Figma Design Review

```
1. Get document overview
   mcporter call figma.get_document_info

2. Analyze current selection
   mcporter call figma.get_selection

3. Check spacing, alignment, typography
   mcporter call figma.get_node_info node_id="<selected_id>"

4. Reference design system guidelines
   mcporter call design-systems.search_design_knowledge query="spacing guidelines"
```

### 4. Component Creation with Best Practices

```
1. Research component patterns
   mcporter call design-systems.search_design_knowledge query="<component> patterns"

2. Check accessibility requirements
   mcporter call design-systems.search_chunks query="<component> ARIA"

3. Create in Figma with proper structure
   mcporter call figma.create_frame ...

4. Validate accessibility
   mcporter call accessibility-scanner.browser_run_accessibility_scan
```

## Design Knowledge Categories

| Category          | Contains                                                |
| ----------------- | ------------------------------------------------------- |
| **accessibility** | WCAG 2.2, WAI-ARIA, color contrast, keyboard navigation |
| **tokens**        | Design tokens spec (DTCG), Style Dictionary             |
| **components**    | Component patterns, Storybook, documentation            |
| **figma**         | Figma best practices, plugins, Dev Mode                 |
| **foundations**   | Typography, color, spacing, layout grids                |
| **governance**    | Design system governance, contribution models           |
| **tools**         | Design tooling, automation, CI/CD                       |
| **documentation** | Documentation practices, ADRs                           |
| **case-studies**  | Real-world design system implementations                |
| **workflow**      | Design-dev handoff, collaboration                       |

## Figma Plugin Setup (Required for Figma MCP)

1. Open Figma Desktop
2. Go to Plugins > Development > Import plugin from manifest
3. Import from: `~/.npm/_npx/.../cursor-talk-to-figma-mcp/src/cursor_mcp_plugin/manifest.json`
4. Run the plugin: Plugins > Development > Figma MCP

Or use Community plugin "Cursor Talk to Figma" if available.

## Tips

- Always verify accessibility with `browser_run_accessibility_scan` before finalizing
- Use `search_design_knowledge` to find best practices before implementing
- Reference WCAG guidelines for any user-facing component
- Document design decisions with rationale from design-systems knowledge base

## Troubleshooting

**mcporter not found:**

```bash
export PATH=/opt/homebrew/bin:$PATH
# or add to ~/.zshrc
```

**Figma MCP not connecting:**

- Ensure Figma Desktop is open
- Run the Figma MCP plugin in Figma
- WebSocket server may need restart

**Accessibility scanner slow:**

- First run downloads Playwright browsers
- Subsequent runs are faster
