import { MessageSchema, type Message } from '../envelope/messages'
import { getContact } from '../store/contacts'
import type { Store } from '../store/db'
import { getInboxQuestion } from '../store/inbox'
import type { OutboxItem } from '../store/outbox'

// Runs inside claimDue's transaction, on the same store connection. Decisions that close something
// (a rejection, a revocation, a rejected question) may always go out, because they are exactly what
// a non-approved contact must receive. Everything that grants or uses a permission goes out only
// while that permission, with that generation, is still the current one.
export function authorizeOutboxItem(store: Store, item: OutboxItem): boolean {
  let message: Message
  try {
    message = MessageSchema.parse(JSON.parse(item.rumor.content))
  } catch {
    return false
  }
  switch (message.type) {
    case 'connect_rejected':
    case 'connect_revoked':
    case 'rejected':
      return true
    case 'connect_approved': {
      const contact = getContact(store, item.recipient, 'inbound')
      return contact?.state === 'approved' && contact.generation === message.generation
    }
    case 'receipt':
    case 'answer': {
      const question = getInboxQuestion(store, item.recipient, message.questionId)
      const contact = getContact(store, item.recipient, 'inbound')
      return question !== null && contact?.state === 'approved' && contact.generation === question.generation
    }
    case 'connect_request': {
      const contact = getContact(store, item.recipient, 'outbound')
      return contact?.state === 'pending' && contact.requestId === message.requestId
    }
    case 'question': {
      const contact = getContact(store, item.recipient, 'outbound')
      return contact?.state === 'approved' && contact.generation === message.generation
    }
  }
}
