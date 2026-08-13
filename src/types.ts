export type Step = {
  id: number;
  procedure_id: number;
  order_index: number;
  title: string;
  description: string;
  command?: string | null;
  requires_evidence: boolean;
};

export type Procedure = {
  id: number;
  name: string;
  description: string;
  category?: string | null;
  created_at: string;
  updated_at: string;
  steps: Step[];
};

export type StepInput = Omit<Step, 'id' | 'procedure_id' | 'order_index'> & { id?: number };
export type ProcedureInput = {
  id?: number;
  name: string;
  description: string;
  category?: string;
  steps: StepInput[];
};

export type Execution = {
  id: number;
  run_id: string;
  step_id: number;
  confirmed_at?: string | null;
  notes?: string | null;
  evidence_path?: string | null;
  captured_at?: string | null;
};

export type Run = {
  id: string;
  procedure_id: number;
  status: 'running' | 'paused' | 'completed' | 'cancelled';
  started_at: string;
  completed_at?: string | null;
  procedure_name?: string;
  confirmed_count?: number;
  evidence_count?: number;
};

export type RunDetails = { run: Run; procedure: Procedure; executions: Execution[] };
