/**
 * The model-facing read_document tool: returns the full extracted text of an
 * imported document by its id (the id printed in the `[document …]` header of
 * the user message). The primary access path for every imported document.
 * @module dsh-doc-import/tool
 */

import { defineTool, type GenericCallView, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { DocStore } from './store.js'

const DESCRIPTION_HEAD =
  'Read the full extracted text of a document the user imported through the dsh-doc-import plugin. '
  + 'Whenever a user message contains a `[document …, id: …]` header, this is THE way to access that '
  + 'document: call this tool with the id from the header. The id is not a file path — it cannot be '
  + 'found on disk, so never search the filesystem for it. '
  + 'For long documents, page through with offset: pass offset+chars from the previous call as the '
  + 'next offset until truncated is false (an empty text result means you have reached the end). '

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
      offset: {
        type: 'integer',
        description: 'Optional: 0-based character offset to start reading from; use offset+chars of the previous call to continue reading a long document.',
      },
      maxChars: {
        type: 'integer',
        description: 'Optional: read at most N characters starting at offset (or from the beginning when offset is omitted).',
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
          totalChars: { type: 'integer', required: true },
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
      const full = await store.readText(meta.id)
      const totalChars = full.length
      const offset = args.offset !== undefined && args.offset > 0 ? Math.floor(args.offset) : 0
      if (offset >= totalChars) {
        return { text: '', name: meta.name, chars: 0, totalChars, truncated: false }
      }
      let text = full.slice(offset)
      if (args.maxChars !== undefined && args.maxChars > 0 && text.length > args.maxChars) {
        text = text.slice(0, args.maxChars)
      }
      const truncated = offset + text.length < totalChars
      return { text, name: meta.name, chars: text.length, totalChars, truncated }
    },
  })
}
