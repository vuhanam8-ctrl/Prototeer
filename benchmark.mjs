import {performance} from 'node:perf_hooks';
import {createDemoWorld,createWorld,makeTool,place,step} from './public/engine.js';

function measure(name,create,ticks){
  const world=create();
  const start=performance.now();
  for(let i=0;i<ticks;i++)step(world);
  const elapsed=performance.now()-start;
  return {name,ticks,objects:world.entities.length,totalMs:Number(elapsed.toFixed(2)),msPerTick:Number((elapsed/ticks).toFixed(3))};
}

function crowd(){
  const world=createWorld(),object=makeTool('Benchmark object');
  world.tools.push(object);
  for(let i=0;i<500;i++)place(world,object.id,i%64,Math.floor(i/64));
  return world;
}

const results=[
  measure('pursuit-demo',createDemoWorld,500),
  measure('500-object-crowd',crowd,100)
];
console.table(results);
