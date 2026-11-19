// @vitest-environment jsdom
/**
 * External task-creation backend contract in NewTaskModal:
 * the modal renders `seats.createSection`, validates non-blank titles when an
 * external backend is selected, invokes `prepareCreate`, applies fallback
 * `prompt` / `workspaceId` only when unset, and forwards `integrations` to
 * `controller.createTaskConfirmed`.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NewTaskModal } from '../src/client/board/NewTaskModal.tsx'
import { EMPTY_TASK_BOARD_SEATS, TaskBoardSeatsProvider } from '../src/client/seats.tsx'
import { t } from '../src/client/locales.ts'
import type { BoardController, ControllerSnapshot } from '../src/core/controller.ts'
import type {
  TaskBoardCreateBackendSelection,
  TaskBoardCreateSectionProps,
} from '../src/core/extension.ts'
import type { TaskRecord } from '../src/core/tasks.ts'
import { openFormSection } from './form-sections.ts'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const roots: Root[] = []

afterEach(() => {
  for (const root of roots.splice(0)) act(() => { root.unmount() })
  document.body.replaceChildren()
  window.localStorage.clear()
})

const createdTask = { id: 'task-ext-1' } as TaskRecord

function makeBackend(
  overrides: Partial<TaskBoardCreateBackendSelection> = {},
): TaskBoardCreateBackendSelection {
  return {
    extensionId: 'ext-tracker',
    label: 'External Tracker',
    prepareCreate: vi.fn(async () => ({
      payload: { ref: 'EXT-42' },
      prompt: 'Backend fallback prompt',
      workspaceId: 'ws-backend',
    })),
    ...overrides,
  }
}

function renderModal(options: {
  backend?: TaskBoardCreateBackendSelection
  canParseTask?: boolean
  parseTaskDraft?: unknown
  started?: boolean
} = {}): {
  container: HTMLElement
  createTaskConfirmed: ReturnType<typeof vi.fn>
  runTask: ReturnType<typeof vi.fn>
  openTask: ReturnType<typeof vi.fn>
  onClose: ReturnType<typeof vi.fn>
  parseTaskDraft: ReturnType<typeof vi.fn>
  getLastSectionProps: () => TaskBoardCreateSectionProps | undefined
} {
  let lastSectionProps: TaskBoardCreateSectionProps | undefined
  const parseTaskDraft = (options.parseTaskDraft ?? vi.fn(async () => ({
    title: 'Parsed title',
    description: 'Parsed description',
    prompt: 'Parsed prompt',
  }))) as ReturnType<typeof vi.fn>
  const createTaskConfirmed = vi.fn(async () => createdTask)
  const runTask = vi.fn(async () => options.started ?? true)
  const openTask = vi.fn()
  const onClose = vi.fn()

  const snapshot: ControllerSnapshot = {
    tasks: [],
    boardOpen: true,
    archiveView: false,
    selectedTaskId: undefined,
    executionOptions: { workspaces: [], presets: [], models: [] },
    pendingTaskIds: [],
    ...(options.canParseTask ? { canParseTask: true } : {}),
  }

  const controller = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    createTaskConfirmed,
    runTask,
    openTask,
    parseTaskDraft,
    dispatchExtension: vi.fn(async () => true),
  } as unknown as BoardController

  const seats = {
    ...EMPTY_TASK_BOARD_SEATS,
    createSection: (props: TaskBoardCreateSectionProps) => {
      lastSectionProps = props
      if (options.backend === undefined) return null
      return (
        <button
          type="button"
          data-testid="select-backend"
          onClick={() => props.onSelect(props.selected === undefined ? options.backend : undefined)}
        >
          {props.selected === undefined ? 'Select backend' : props.selected.label}
        </button>
      )
    },
  }

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  act(() => {
    root.render(
      <TaskBoardSeatsProvider value={seats}>
        <NewTaskModal controller={controller} onClose={onClose} />
      </TaskBoardSeatsProvider>,
    )
  })
  return {
    container,
    createTaskConfirmed,
    runTask,
    openTask,
    onClose,
    parseTaskDraft,
    getLastSectionProps: () => lastSectionProps,
  }
}

function field(container: HTMLElement, placeholder: string): HTMLInputElement | HTMLTextAreaElement {
  const element = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[placeholder="${placeholder}"]`)
  if (element === null) throw new Error(`no field with placeholder ${placeholder}`)
  return element
}

function typeInto(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')!.set!
  act(() => {
    setter.call(element, value)
    element.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function buttonByText(container: HTMLElement, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find(candidate => candidate.textContent === label)
  if (button === undefined) throw new Error(`no button labelled ${label}`)
  return button as HTMLButtonElement
}

function selectBackend(container: HTMLElement): void {
  const btn = container.querySelector<HTMLButtonElement>('[data-testid="select-backend"]')
  if (btn === null) throw new Error('no backend toggle button')
  act(() => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
}

describe('NewTaskModal external create backend contract', () => {
  it('user calls prepareCreate on manual submit, applies fallback prompt/workspaceId when unset, and commits integrations', async () => {
    // Given an open new-task modal with a selected external creation backend and only title/description filled
    const backend = makeBackend()
    const { container, createTaskConfirmed, onClose } = renderModal({ backend })
    selectBackend(container)
    typeInto(field(container, t('new.titlePlaceholder')), '  Manual task  ')
    typeInto(field(container, t('new.descriptionPlaceholder')), '  Details here  ')

    // When the user submits the form
    await act(async () => {
      buttonByText(container, t('new.submit')).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // Then prepareCreate receives trimmed fields, fallback prompt and workspaceId are applied, and integrations[extensionId] is committed
    expect(backend.prepareCreate).toHaveBeenCalledWith({
      title: 'Manual task',
      description: 'Details here',
      prompt: '',
      tags: [],
    })
    expect(createTaskConfirmed).toHaveBeenCalledWith(expect.objectContaining({
      title: '  Manual task  ',
      description: '  Details here  ',
      prompt: 'Backend fallback prompt',
      workspaceId: 'ws-backend',
      integrations: { 'ext-tracker': { ref: 'EXT-42' } },
    }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('user runs AI Parse to populate title, description, prompt and submitting with a selected backend preserves the AI-parsed prompt', async () => {
    // Given an open modal with AI parse enabled and a selected external backend returning a fallback prompt
    const backend = makeBackend()
    const { container, createTaskConfirmed, parseTaskDraft, onClose } = renderModal({
      backend,
      canParseTask: true,
    })
    selectBackend(container)
    openFormSection(container, t('new.section.parse'))
    typeInto(field(container, t('new.aiParsePlaceholder')), 'Fix login timeout')

    // When the user runs AI parse and then submits
    await act(async () => {
      buttonByText(container, t('new.aiParseRun')).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      buttonByText(container, t('new.submit')).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // Then AI parse populated the fields, prepareCreate received them, and the AI-parsed prompt was preserved over the backend fallback
    expect(parseTaskDraft).toHaveBeenCalledOnce()
    expect(backend.prepareCreate).toHaveBeenCalledWith({
      title: 'Parsed title',
      description: 'Parsed description',
      prompt: 'Parsed prompt',
      tags: [],
    })
    expect(createTaskConfirmed).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Parsed title',
      description: 'Parsed description',
      prompt: 'Parsed prompt',
      workspaceId: 'ws-backend',
      integrations: { 'ext-tracker': { ref: 'EXT-42' } },
    }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('user sees the error, modal remains open, and no local task is created when prepareCreate throws', async () => {
    // Given an open modal with a selected backend whose prepareCreate rejects
    const backend = makeBackend({
      prepareCreate: vi.fn(async () => { throw new Error('remote create rejected') }),
    })
    const { container, createTaskConfirmed, onClose } = renderModal({ backend })
    selectBackend(container)
    typeInto(field(container, t('new.titlePlaceholder')), 'Failing task')

    // When the user submits
    await act(async () => {
      buttonByText(container, t('new.submit')).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // Then the modal displays the error, stays open, and does not create a local task
    expect(container.textContent).toContain('remote create rejected')
    expect(createTaskConfirmed).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('user clicking "Create & Run" with a selected external backend creates the task with integrations and starts execution', async () => {
    // Given an open modal with a selected external backend and a valid title
    const backend = makeBackend()
    const { container, createTaskConfirmed, runTask, onClose } = renderModal({ backend })
    selectBackend(container)
    typeInto(field(container, t('new.titlePlaceholder')), 'Run me now')

    // When the user clicks "Create & Run"
    await act(async () => {
      buttonByText(container, t('new.createAndRun')).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // Then the task is created with integrations, execution starts, and the modal closes
    expect(backend.prepareCreate).toHaveBeenCalledOnce()
    expect(createTaskConfirmed).toHaveBeenCalledWith(expect.objectContaining({
      integrations: { 'ext-tracker': { ref: 'EXT-42' } },
    }))
    expect(runTask).toHaveBeenCalledWith('task-ext-1')
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('user sees new.required locally when title is blank and an external backend is selected, without calling prepareCreate', async () => {
    // Given an open modal with a selected external backend and a whitespace-only title
    const backend = makeBackend()
    const { container, createTaskConfirmed, onClose } = renderModal({ backend })
    selectBackend(container)
    typeInto(field(container, t('new.titlePlaceholder')), '   ')

    // When the user submits
    await act(async () => {
      buttonByText(container, t('new.submit')).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    // Then validation fails locally with t('new.required'), prepareCreate is not called, and no task is created
    expect(container.textContent).toContain(t('new.required'))
    expect(backend.prepareCreate).not.toHaveBeenCalled()
    expect(createTaskConfirmed).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
  })
})
