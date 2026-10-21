import type { ReactNode } from 'react';
import { requireRelaySession } from '@/lib/relay-session';
import { getRelayRuntime } from '@/server/relay/runtime';
import { WorkspaceProvider } from '@/components/relay/workspace-context';
import { RelayWorkspaceShell } from '@/components/relay/workspace-shell';
import './dashboard.css';
import '@/components/dashboard/console.css';
export const metadata={title:{default:'Console',template:'%s · Relay'},robots:{index:false,follow:false}};
export default async function DashboardLayout({children}:{children:ReactNode}){const {user}=await requireRelaySession();const runtime=getRelayRuntime();const data=runtime.store.workspace(user.id);return <WorkspaceProvider initialData={data} initialUser={{id:user.id,name:user.name,email:user.email}}><RelayWorkspaceShell>{children}</RelayWorkspaceShell></WorkspaceProvider>;}
