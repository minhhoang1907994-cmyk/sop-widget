import { invoke } from '@tauri-apps/api/core';
import type { Procedure, ProcedureInput, Run, RunDetails } from './types';

export const api = {
  listProcedures: () => invoke<Procedure[]>('list_procedures'),
  saveProcedure: (procedure: ProcedureInput) => invoke<Procedure>('save_procedure', { input: procedure }),
  deleteProcedure: (id: number) => invoke<void>('delete_procedure', { id }),
  startRun: (procedureId: number) => invoke<Run>('start_run', { procedureId }),
  getRun: (runId: string) => invoke<RunDetails>('get_run', { runId }),
  listRuns: () => invoke<Run[]>('list_runs'),
  confirmStep: (runId: string, stepId: number, notes: string) => invoke<void>('confirm_step', { runId, stepId, notes }),
  captureEvidence: (runId: string, stepId: number) => invoke<string>('capture_evidence', { runId, stepId }),
  setRunStatus: (runId: string, status: string) => invoke<void>('set_run_status', { runId, status }),
  exportReport: (runId: string) => invoke<string>('export_report', { runId })
};
