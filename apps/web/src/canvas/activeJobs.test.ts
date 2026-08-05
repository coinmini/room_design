import { describe, expect, it, beforeEach } from 'vitest'
import {
  actionFromJobType,
  clearActiveCanvasJobs,
  isActiveJobStatus,
  loadActiveCanvasJobs,
  parentAssetIdFromJob,
  removeActiveCanvasJob,
  upsertActiveCanvasJob,
  workflowStageFromAction,
} from './activeJobs'
import type { Job } from '../api'

describe('activeJobs storage', () => {
  const projectId = 'proj-test'

  beforeEach(() => {
    clearActiveCanvasJobs(projectId)
  })

  it('upserts and loads records by jobId / groupId', () => {
    upsertActiveCanvasJob(projectId, {
      jobId: 'j1',
      action: 'generate_layout',
      groupId: 'g1',
      slots: [{ id: 'g1-1', label: '布局方案 1', workflowStage: 'layout' }],
      updatedAt: 1,
    })
    expect(loadActiveCanvasJobs(projectId)).toHaveLength(1)

    // same groupId replaces previous
    upsertActiveCanvasJob(projectId, {
      jobId: 'j2',
      action: 'generate_layout',
      groupId: 'g1',
      slots: [{ id: 'g1-1', label: '布局方案 1', workflowStage: 'layout' }],
      updatedAt: 2,
    })
    const jobs = loadActiveCanvasJobs(projectId)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].jobId).toBe('j2')

    removeActiveCanvasJob(projectId, { jobId: 'j2' })
    expect(loadActiveCanvasJobs(projectId)).toHaveLength(0)
  })
})

describe('activeJobs pure maps', () => {
  it('maps job types to canvas actions', () => {
    expect(actionFromJobType('LAYOUT_AI')).toBe('generate_layout')
    expect(actionFromJobType('AI_COLOR_PLAN')).toBe('generate_color_plan')
    expect(actionFromJobType('AI_AXONOMETRIC')).toBe('generate_axonometric')
    expect(actionFromJobType('AI_SPACE_RENDER')).toBe('generate_space_render')
    expect(actionFromJobType('UNKNOWN')).toBeNull()
  })

  it('maps actions to workflow stages', () => {
    expect(workflowStageFromAction('generate_layout')).toBe('layout')
    expect(workflowStageFromAction('generate_color_plan')).toBe('color_plan')
    expect(workflowStageFromAction('local_edit')).toBe('local_edit')
  })

  it('detects active status and parent asset from payload', () => {
    expect(isActiveJobStatus('QUEUED')).toBe(true)
    expect(isActiveJobStatus('RUNNING')).toBe(true)
    expect(isActiveJobStatus('SUCCEEDED')).toBe(false)

    const job = {
      payload: { asset_parent_id: 'asset-9' },
    } as unknown as Job
    expect(parentAssetIdFromJob(job)).toBe('asset-9')
  })
})
