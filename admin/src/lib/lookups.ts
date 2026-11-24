import { q, supabase } from './supabase';
import { useAsync } from './hooks';
import type { Site } from './types';

export interface EmployeeLite {
  id: string;
  employee_code: string;
  display_name: string;
  is_active: boolean;
  current_site_id: string | null;
}

export function useSites() {
  return useAsync(() => q<Site[]>(supabase.from('sites').select('*').order('name')), []);
}

export function useEmployeesLite(includeInactive = false) {
  return useAsync(async () => {
    let query = supabase.from('v_employee_overview')
      .select('id, employee_code, display_name, is_active, current_site_id')
      .order('last_name').order('first_name');
    if (!includeInactive) query = query.eq('is_active', true);
    return q<EmployeeLite[]>(query);
  }, [includeInactive]);
}

export function employeeLabel(e: { employee_code: string; display_name: string }): string {
  return `${e.display_name} (${e.employee_code})`;
}
