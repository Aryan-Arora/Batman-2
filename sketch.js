
const Engine = Matter.Engine;
const World = Matter.World;
const Bodies = Matter.Bodies;
const Body = Matter.Body;
const Constraint = Matter.Constraint;

var batman;
var ground;
var lightning;
var raindrop1;
var raindrops=[]

var lightningSound;
var rainSound;
var cloud1;
var cloud2;
var cloud3;
var cloud4;



function preload(){
    batman_walking=loadAnimation("walking_1.png","walking_2.png","walking_3.png","walking_4.png","walking_5.png","walking_6.png","walking_7.png","walking_8.png")
    lightning1_Img=loadImage("1.png")
    lightning2_Img=loadImage("2.png")
    lightning3_Img=loadImage("3.png")
    lightning4_Img=loadImage("4.png")
    cloud_Img=loadImage("12.jpg")
    rainSound=loadSound("rain-02.mp3")
}

function setup(){
   createCanvas(1200,500)

   engine = Engine.create();
	world = engine.world;
   batman=createSprite(600,380,10,10)
       
  batman.addAnimation("walking",batman_walking)
   batman.scale=0.3
  

   ground=createSprite(0,485,3000,10)
   

   
   
Engine.run(engine);
}

function draw(){
    background(0)
    createLightning();
   rainSound.play();
   cloud1=createSprite(50,40,20,20)
   cloud1.addImage(cloud_Img)
   cloud1.scale=0.7
   cloud1.depth=0;
   cloud2=createSprite(370,40,20,20)
   cloud2.addImage(cloud_Img)
   cloud2.scale=0.7
   cloud2.depth=0;
   cloud3=createSprite(705,40,20,20)
   cloud3.addImage(cloud_Img)
   cloud3.scale=0.7
   cloud3.depth=0;
   cloud4=createSprite(1040,40,20,20)
cloud4.addImage(cloud_Img)
cloud4.scale=0.7
cloud4.depth=0;
     

    var maxdrops=100;
     if(frameCount%8===0){
         for(i=0;i<maxdrops;i++){
        raindrops.push(new raindrop(random(0,3000), random(0,40),5));
         }
      }
    
     for (var j = 0; j < raindrops.length; j++) {
      
        raindrops[j].display();
      }
     

    drawSprites();
}   
function createLightning(){
    if(frameCount%100===0){
lightning=createSprite(random(1,1000),100,200,200)
lightning.scale=0.3
lightning.velocityX=-3

var rand=Math.round(random(1,4))
switch(rand){
    case 1:lightning.addImage(lightning1_Img)
     break;
     case 2:lightning.addImage(lightning2_Img)
     break;
     case 3:lightning.addImage(lightning3_Img)
     break;
     case 4:lightning.addImage(lightning4_Img)
     break;
     default:break;

}
lightning.lifetime=10




    }
}
