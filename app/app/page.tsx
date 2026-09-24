'use client';
import { useEffect } from 'react';
import Workspace from '../../components/Workspace';

export default function Page() {
  useEffect(() => {
    console.log('This is leadmelo');
  }, []);
  return <Workspace section="overview"/>;
}
