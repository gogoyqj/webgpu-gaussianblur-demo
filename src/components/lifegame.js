export async function lifegame() {
    const GRID_SIZE = 32;
    const WORKGROUP_SIZE = 8;
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      throw new Error("No appropriate GPUAdapter found.");
    }
    const device = await adapter.requestDevice();

    const canvas = document.getElementById("canvas");
    const context = canvas.getContext("webgpu");
    const canvasFormat = navigator.gpu.getPreferredCanvasFormat();
    context.configure({
      device: device,
      format: canvasFormat,
    });

    const vertices = new Float32Array([
      //   X,    Y,
      -0.8, -0.8, 
      0.8, -0.8, 
      0.8,  0.8,

      -0.8, -0.8,
      0.8, 0.8, 
      -0.8, 0.8,
    ]);

    const vertexBuffer = device.createBuffer({
      label: "Cell vertices",
      size: vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    });

    device.queue.writeBuffer(vertexBuffer, /*bufferOffset=*/0, vertices);


    const vertexBufferLayout = {
      arrayStride: 8, // 找下一个顶点，需要偏移的字节大小
      attributes: [{
        format: "float32x2",
        offset: 0,
        shaderLocation: 0, // Position, see vertex shader
      }],
    };

    const uniformArray = new Float32Array([GRID_SIZE, GRID_SIZE]);
    const uniformBuffer = device.createBuffer({
      label: "Grid Uniforms",
      size: uniformArray.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(uniformBuffer, 0, uniformArray);

    const cellStateArray = new Uint32Array(GRID_SIZE * GRID_SIZE);
    const cellStateStorage = [
      device.createBuffer({
        label: "Cell State A",
        size: cellStateArray.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      }),
      device.createBuffer({
        label: "Cell State B",
        size: cellStateArray.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      })
    ];
    // for (let i = 0; i < cellStateArray.length; i+=3) {
    //   cellStateArray[i] = 1;
    // }
    // device.queue.writeBuffer(cellStateStorage[0], 0, cellStateArray);
    // for (let i = 0; i < cellStateArray.length; i++) {
    //   cellStateArray[i] = i % 2;
    // }
    // device.queue.writeBuffer(cellStateStorage[1], 0, cellStateArray);
    for (let i = 0; i < cellStateArray.length; ++i) {
      cellStateArray[i] = Math.random() > 0.6 ? 1 : 0;
    }
    device.queue.writeBuffer(cellStateStorage[0], 0, cellStateArray); 


    const cellShaderModule = device.createShaderModule({
      label: "Cell shader",
      code: `
        struct VertexInput {
          @location(0) pos: vec2f,
          @builtin(instance_index) instance: u32,
        };

        struct VertexOutput {
          @builtin(position) pos: vec4f,
          @location(0) cell: vec2f,
        };

        struct FragInput {
          @location(0) cell: vec2f,
        };

        @group(0) @binding(0) var<uniform> grid: vec2f;
        @group(0) @binding(1) var<storage> cellState: array<u32>; 

        @vertex
        fn vertexMain(input: VertexInput) -> VertexOutput {
          let i = f32(input.instance);
          let cell = vec2f(i % grid[0], floor(i / grid.x));
          let state = f32(cellState[input.instance]);

          let cellOffset = cell / grid * 2; // Compute the offset to cell
          let gridPos = (input.pos*state + 1) / grid - 1 + cellOffset; // Add it here!

          var output: VertexOutput;
          output.pos = vec4f(gridPos, 0, 1);
          output.cell = cell;
          return output;
        }
        
        @fragment
        fn fragmentMain(input: FragInput) -> @location(0) vec4f {
          let c = input.cell / grid;
          return vec4f(c, 1-c.x, 1);
        }
      `
    });


    const simulationShaderModule = device.createShaderModule({
      label: "Game of Life simulation shader",
      code: `
        @group(0) @binding(0) var<uniform> grid: vec2f;

        @group(0) @binding(1) var<storage> cellStateIn: array<u32>;
        @group(0) @binding(2) var<storage, read_write> cellStateOut: array<u32>;

        fn cellIndex(cell: vec2u) -> u32 {
          return (cell.y % u32(grid.y)) * u32(grid.x) +
                (cell.x % u32(grid.x));
        }

        fn cellActive(x: u32, y: u32) -> u32 {
          return cellStateIn[cellIndex(vec2(x, y))];
        }

        @compute @workgroup_size(${WORKGROUP_SIZE}, ${WORKGROUP_SIZE})
        fn computeMain(@builtin(global_invocation_id) cell: vec3u) {
          let activeNeighbors = cellActive(cell.x+1, cell.y+1) +
                        cellActive(cell.x+1, cell.y) +
                        cellActive(cell.x+1, cell.y-1) +
                        cellActive(cell.x, cell.y-1) +
                        cellActive(cell.x-1, cell.y-1) +
                        cellActive(cell.x-1, cell.y) +
                        cellActive(cell.x-1, cell.y+1) +
                        cellActive(cell.x, cell.y+1);
          let i = cellIndex(cell.xy);

          switch activeNeighbors {
            case 2: { // Active cells with 2 neighbors stay active.
              cellStateOut[i] = cellStateIn[i];
            }
            case 3: { // Cells with 3 neighbors become or stay active.
              cellStateOut[i] = 1;
            }
            default: { // Cells with < 2 or > 3 neighbors become inactive.
              cellStateOut[i] = 0;
            }
          }
        }
      `
    });

    const bindGroupLayout = device.createBindGroupLayout({
      label: "Cell Bind Group Layout",
      entries: [{
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.COMPUTE | GPUShaderStage.FRAGMENT,
        buffer: {}
      }, {
        binding: 1,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.COMPUTE,
        buffer: { type: "read-only-storage"}
      }, {
        binding: 2,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "storage"}
      }]
    });

    const bindGroups = [
      device.createBindGroup({
        label: "Cell renderer bind group A",
        layout: bindGroupLayout,
        entries: [
            {
            binding: 0,
            resource: { buffer: uniformBuffer }
          },
          {
            binding: 1,
            resource: { buffer: cellStateStorage[0] }
          },
          {
            binding: 2,
            resource: { buffer: cellStateStorage[1] }
          }
        ],
      }),
      device.createBindGroup({
        label: "Cell renderer bind group B",
        layout: bindGroupLayout,
        entries: [
          {
            binding: 0,
            resource: { buffer: uniformBuffer }
          },
          {
            binding: 1,
            resource: { buffer: cellStateStorage[1] }
          },
          {
            binding: 2, // New Entry
            resource: { buffer: cellStateStorage[0] }
          },
        ],
      })
    ];

    const pipelineLayout = device.createPipelineLayout({
      label: "Cell Pipeline Layout",
      bindGroupLayouts: [ bindGroupLayout ],
    });



    const cellPipeline = device.createRenderPipeline({
      label: "Cell pipeline",
      layout: pipelineLayout,
      vertex: {
        module: cellShaderModule,
        entryPoint: "vertexMain",
        buffers: [vertexBufferLayout]
      },
      fragment: {
        module: cellShaderModule,
        entryPoint: "fragmentMain",
        targets: [{
          format: canvasFormat
        }]
      }
    });

    const simulationPipeline = device.createComputePipeline({
      label: "Simulation pipeline",
      layout: pipelineLayout,
      compute: {
        module: simulationShaderModule,
        entryPoint: "computeMain",
      }
    });

    let step = 0;
    function render() {
      const encoder = device.createCommandEncoder();

      const computePass = encoder.beginComputePass();

      computePass.setPipeline(simulationPipeline);
      computePass.setBindGroup(0, bindGroups[step % 2]);

      const workgroupCount = Math.ceil(GRID_SIZE / WORKGROUP_SIZE);
      computePass.dispatchWorkgroups(workgroupCount, workgroupCount);

      computePass.end();

      step++;

      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: context.getCurrentTexture().createView(),
            clearValue: { r: 0, g: 0, b: 0.4, a: 1 }, // New line
            loadOp: "clear",
            storeOp: "store",
          },
        ],
      });

      pass.setPipeline(cellPipeline);
      pass.setVertexBuffer(0, vertexBuffer);
      pass.setBindGroup(0, bindGroups[step % 2]);
      pass.draw(vertices.length / 2, GRID_SIZE * GRID_SIZE);

      pass.end();
      device.queue.submit([encoder.finish()]);

    }

    // setInterval(render, 200);
    render()
}