export type Project = {
  id: string;
  name: string;
  address?: string | null;
  created_at?: string | null;
};

export type DataPoint = {
  id: string;
  project_id: string;
  point_index: number | null;
  lat: number | null;
  lng: number | null;
  descriptor: string | null;
  created_at?: string | null;
  source?: string | null;
  deleted?: boolean;
};
