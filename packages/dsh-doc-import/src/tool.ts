/**
 * The model-facing read_document tool: returns the full extracted text of an
 * imported document by its id (the id printed in the `[document …]` header of
 * the user message). Used when the inlined text was truncated.
 * @module dsh-doc-import/tool
 */

import { defineTool, type GenericCallView, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { DocStore } from './store.js'

const DESCRIPTION_HEAD =
  'Read the full extracted text of a document the user imported through the dsh-doc-import plugin. '
  + 'Use when a user message contains a `[document …]` header whose text is truncated (the header says '
  + '内联截断 or 已截断), or when the user asks about a document by name and its full content is not '
  + 'already visible in the conversation. '

/** Pure pending-state card for one read_document call. */
export function readDocumentCallView(args: { docId: string }): GenericCallView {
  return {
    card: 'generic',
    title: 'Read document',
    kind: 'read',
    rawInput: args,
  }
}

/** Build the read_document tool definition against one doc store. */
export function readDocumentTool(store: DocStore): ToolDefinition {
  return defineTool({
    name: 'read_document',
    description: DESCRIPTION_HEAD
      + 'The docId is the long sha256 hex id printed in the `[document …]` header. '
      + 'The returned text may be very long; pass maxChars to read only the first N characters.',
    parameters: {
      docId: {
        type: 'string',
        required: true,
        description: 'The document id from the `[document …, id: …]` header in the user message.',
      },
      maxChars: {
        type: 'integer',
        description: 'Optional: read only the first N characters of the extracted text.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          name: { type: 'string', required: true },
          chars: { type: 'integer', required: true },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
      presentationMeta: (_args, value) => ({ name: value.name, chars: value.chars }),
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const meta = store.registry.get(args.docId)
      if (meta === undefined) {
        throw new Error(`read_document: no document with id ${args.docId} (it may have been removed or the id is wrong)`)
      }
      let text = await store.readText(meta.id)
      let truncated = false
      if (args.maxChars !== undefined && args.maxChars > 0 && text.length > args.maxChars) {
        text = text.slice(0, args.maxChars)
        truncated = true
      }
      return { text, name: meta.name, chars: text.length, truncated }
    },
  })
}
