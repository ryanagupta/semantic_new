import { WorkspaceView } from '@/components/relay/workspace-view';
export default async function Project({params}:{params:Promise<{id:string}>}){const {id}=await params;return <WorkspaceView mode="project" projectId={id}/>;}
