import type { Tool } from '@modelcontextprotocol/sdk/types.js';

import { registerNoteTools } from './notes.js';
import { registerSearchTools } from './search.js';
import { registerOrganizationTools } from './organization.js';
import { registerAttributeTools } from './attributes.js';
import { registerCalendarTools } from './calendar.js';
import { registerSystemTools } from './system.js';
import { registerAttachmentTools } from './attachments.js';
import { registerRevisionTools } from './revisions.js';
import { TOOL_CATEGORIES, type ToolCategory } from './categories.js';

// Re-export from categories
export { TOOL_CATEGORIES, type ToolCategory };

// Category mapping for each tool
const CATEGORY_MAP: Record<string, ToolCategory> = {};

// Cached tool registry
let cachedTools: Tool[] | null = null;

/**
 * Initialize the category map based on which register function each tool comes from
 */
function initializeCategoryMap(): void {
  const noteTools = registerNoteTools();
  const searchToolsList = registerSearchTools();
  const organizationTools = registerOrganizationTools();
  const attributeTools = registerAttributeTools();
  const calendarTools = registerCalendarTools();
  const systemTools = registerSystemTools();
  const attachmentTools = registerAttachmentTools();
  const revisionTools = registerRevisionTools();

  noteTools.forEach((t) => (CATEGORY_MAP[t.name] = 'notes'));
  searchToolsList.forEach((t) => (CATEGORY_MAP[t.name] = 'search'));
  organizationTools.forEach((t) => (CATEGORY_MAP[t.name] = 'organization'));
  attributeTools.forEach((t) => (CATEGORY_MAP[t.name] = 'attributes'));
  calendarTools.forEach((t) => (CATEGORY_MAP[t.name] = 'calendar'));
  systemTools.forEach((t) => (CATEGORY_MAP[t.name] = 'system'));
  attachmentTools.forEach((t) => (CATEGORY_MAP[t.name] = 'attachments'));
  revisionTools.forEach((t) => (CATEGORY_MAP[t.name] = 'revisions'));
}

/**
 * Get all registered tools (cached after first call)
 */
export function getToolRegistry(): Tool[] {
  if (cachedTools === null) {
    cachedTools = [
      ...registerNoteTools(),
      ...registerSearchTools(),
      ...registerOrganizationTools(),
      ...registerAttributeTools(),
      ...registerCalendarTools(),
      ...registerSystemTools(),
      ...registerAttachmentTools(),
      ...registerRevisionTools(),
    ];
    initializeCategoryMap();
  }
  return cachedTools;
}

/**
 * Get the category for a tool by name
 */
export function getToolCategory(toolName: string): ToolCategory | undefined {
  // Ensure registry is initialized
  getToolRegistry();
  return CATEGORY_MAP[toolName];
}

/**
 * Search result for a single tool
 */
export interface ToolSearchResult {
  name: string;
  description: string;
  category: ToolCategory;
  relevance_score: number;
  matched_in: string[];
  inputSchema?: object;
}

/**
 * Full search response
 */
export interface SearchToolsResponse {
  query: string;
  category: ToolCategory | null;
  total_matches: number;
  returned: number;
  tools: ToolSearchResult[];
}

/**
 * Options for searchTools function
 */
export interface SearchToolsOptions {
  category?: ToolCategory;
  include_schemas?: boolean;
  limit?: number;
}

/**
 * Search tools by keyword with weighted scoring
 *
 * Scoring weights:
 * - Exact name match: 100 pts
 * - Name substring: 50 pts
 * - Description match: 20 pts
 * - Parameter name match: 15 pts each
 * - Parameter description match: 10 pts each
 */
export function searchTools(query: string, options: SearchToolsOptions = {}): SearchToolsResponse {
  const { category, include_schemas = false, limit = 10 } = options;
  const tools = getToolRegistry();

  // Split query into keywords (space-separated, all must match)
  const keywords = query
    .toLowerCase()
    .split(/\s+/)
    .filter((k) => k.length > 0);

  const results: ToolSearchResult[] = [];

  for (const tool of tools) {
    const toolCategory = getToolCategory(tool.name);

    // Filter by category if specified
    if (category && toolCategory !== category) {
      continue;
    }

    let score = 0;
    const matchedIn: string[] = [];
    const nameLower = tool.name.toLowerCase();
    const descLower = (tool.description ?? '').toLowerCase();

    // Track which keywords matched (for AND logic)
    const keywordMatches = new Map<string, boolean>();

    for (const keyword of keywords) {
      let keywordMatched = false;

      // Check name
      if (nameLower === keyword) {
        score += 100;
        if (!matchedIn.includes('name')) matchedIn.push('name');
        keywordMatched = true;
      } else if (nameLower.includes(keyword)) {
        score += 50;
        if (!matchedIn.includes('name')) matchedIn.push('name');
        keywordMatched = true;
      }

      // Check description
      if (descLower.includes(keyword)) {
        score += 20;
        if (!matchedIn.includes('description')) matchedIn.push('description');
        keywordMatched = true;
      }

      // Check parameter names and descriptions
      const properties = tool.inputSchema?.properties as
        Record<string, { description?: string }> | undefined;
      if (properties) {
        for (const [paramName, paramDef] of Object.entries(properties)) {
          if (paramName.toLowerCase().includes(keyword)) {
            score += 15;
            const matchKey = `parameter:${paramName}`;
            if (!matchedIn.includes(matchKey)) matchedIn.push(matchKey);
            keywordMatched = true;
          }
          if (paramDef.description?.toLowerCase().includes(keyword)) {
            score += 10;
            const matchKey = `parameter_desc:${paramName}`;
            if (!matchedIn.includes(matchKey)) matchedIn.push(matchKey);
            keywordMatched = true;
          }
        }
      }

      keywordMatches.set(keyword, keywordMatched);
    }

    // AND logic: all keywords must match somewhere
    const allKeywordsMatched = keywords.every((k) => keywordMatches.get(k));

    if (allKeywordsMatched && score > 0 && toolCategory) {
      const result: ToolSearchResult = {
        name: tool.name,
        description: tool.description ?? '',
        category: toolCategory,
        relevance_score: score,
        matched_in: matchedIn,
      };

      if (include_schemas) {
        result.inputSchema = tool.inputSchema;
      }

      results.push(result);
    }
  }

  // Sort by relevance score (descending)
  results.sort((a, b) => b.relevance_score - a.relevance_score);

  // Apply limit
  const limitedResults = results.slice(0, limit);

  return {
    query,
    category: category ?? null,
    total_matches: results.length,
    returned: limitedResults.length,
    tools: limitedResults,
  };
}
