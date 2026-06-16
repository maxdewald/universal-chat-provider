import { describe, expect, it } from 'vitest'
import { sanitizeGeminiToolSchema } from '../../src/chat/tool-schema'

describe('gemini tool schema sanitization', () => {
  it('recursively drops fields Gemini rejects while keeping the constraints', () => {
    expect(sanitizeGeminiToolSchema({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $comment: 'root metadata',
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          description: 'Lookup mode',
          enum: ['fast', 'thorough'],
          enumDescriptions: ['Quick', 'Thorough'],
          markdownDescription: '**mode**',
        },
        tags: {
          type: 'array',
          items: { $comment: 'tag', type: 'string', pattern: '^[a-z]+$' },
        },
      },
      required: ['mode'],
    })).toEqual({
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          description: 'Lookup mode',
          enum: ['fast', 'thorough'],
        },
        tags: {
          type: 'array',
          items: { type: 'string', pattern: '^[a-z]+$' },
        },
      },
      required: ['mode'],
    })
  })

  it('leaves combinators and refs intact', () => {
    const schema = {
      anyOf: [{ type: 'string' }, { type: 'number' }],
      $defs: { name: { type: 'string' } },
    }
    expect(sanitizeGeminiToolSchema(schema)).toEqual(schema)
  })
})
